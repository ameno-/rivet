import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	DEFAULT_API_KEY_ENV_VARS,
	DEFAULT_GATEWAY_API_KEY_ENV_VAR,
	DEFAULT_GATEWAY_CONTEXT_WINDOW,
	DEFAULT_GATEWAY_MAX_TOKENS,
	DEFAULT_PI_MATE_MODEL,
	DEFAULT_PI_MATE_NAMESPACE,
	DEFAULT_SANDBOX_PROVIDER_NAME,
	DEFAULT_SCOPED_MODELS,
	FirstMateKeyError,
	KEY_SEGMENT_MAX_LENGTH,
	KEY_SEGMENT_PATTERN,
	PI_MATE_API_KEY_ENV_VARS_ENV,
	PI_MATE_GATEWAY_API_KEY_ENV_VAR_ENV,
	PI_MATE_GATEWAY_BASE_URL_ENV,
	PI_MATE_GATEWAY_CONTEXT_WINDOW_ENV,
	PI_MATE_GATEWAY_MAX_TOKENS_ENV,
	PI_MATE_GATEWAY_MODEL_IDS_ENV,
	PI_MATE_MODEL_ENV,
	PI_MATE_NAMESPACE_ENV,
	PI_MATE_SANDBOX_AGENTOS_SOFTWARE_ENV,
	PI_MATE_SANDBOX_CWD_ENV,
	PI_MATE_SANDBOX_DAYTONA_API_KEY_ENV_VAR_ENV,
	PI_MATE_SANDBOX_E2B_API_KEY_ENV_VAR_ENV,
	PI_MATE_SANDBOX_E2B_TEMPLATE_ENV,
	PI_MATE_SANDBOX_PROVIDER_ENV,
	PI_MATE_SCOPED_MODELS_ENV,
	PiMateConfigError,
	SANDBOX_PROVIDER_NAMES,
	firstMateActorKey,
	loadGatewayProviderConfig,
	loadPiMateConfig,
	loadSandboxProviderConfig,
	normalizeKeySegment,
	normalizeThreadSegment,
	redactConfigForLog,
	redactSandboxProviderConfig,
	resolveNamespace,
	shortHash,
} from "../src/config.ts";

const ENV_KEYS = [
	PI_MATE_NAMESPACE_ENV,
	PI_MATE_MODEL_ENV,
	PI_MATE_SCOPED_MODELS_ENV,
	PI_MATE_API_KEY_ENV_VARS_ENV,
	PI_MATE_GATEWAY_BASE_URL_ENV,
	PI_MATE_GATEWAY_API_KEY_ENV_VAR_ENV,
	PI_MATE_GATEWAY_MODEL_IDS_ENV,
	PI_MATE_GATEWAY_CONTEXT_WINDOW_ENV,
	PI_MATE_GATEWAY_MAX_TOKENS_ENV,
	PI_MATE_SANDBOX_PROVIDER_ENV,
	PI_MATE_SANDBOX_CWD_ENV,
	PI_MATE_SANDBOX_AGENTOS_SOFTWARE_ENV,
	PI_MATE_SANDBOX_DAYTONA_API_KEY_ENV_VAR_ENV,
	PI_MATE_SANDBOX_E2B_API_KEY_ENV_VAR_ENV,
	PI_MATE_SANDBOX_E2B_TEMPLATE_ENV,
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("normalizeKeySegment", () => {
	test("lowercases and trims a basic input", () => {
		expect(normalizeKeySegment("  AcmeCo  ")).toBe("acmeco");
	});

	test("collapses runs of non-alphanumeric characters to a single hyphen", () => {
		expect(normalizeKeySegment("Acme/Co::Project#01")).toBe(
			"acme-co-project-01",
		);
	});

	test("rejects empty input", () => {
		expect(() => normalizeKeySegment("   ")).toThrow(FirstMateKeyError);
	});

	test("rejects inputs that contain no alphanumeric characters", () => {
		expect(() => normalizeKeySegment("---")).toThrow(FirstMateKeyError);
	});

	test("rejects inputs longer than 63 characters after normalization", () => {
		const input = "a".repeat(64);
		expect(() => normalizeKeySegment(input)).toThrow(FirstMateKeyError);
	});
});

describe("firstMateActorKey", () => {
	test("returns the documented four-segment tuple", () => {
		expect(
			firstMateActorKey({
				ownerScope: "acme",
				projectId: "northstar",
				threadId: "thread-01",
			}),
		).toEqual(["mate", "acme", "northstar", "thread-01"]);
	});

	test("is deterministic across equivalent inputs", () => {
		const a = firstMateActorKey({
			ownerScope: "Acme Co.",
			projectId: "North Star",
			threadId: "Slack / Thread #1",
		});
		const b = firstMateActorKey({
			ownerScope: "acme-co",
			projectId: "north-star",
			threadId: "slack-thread-1",
		});
		expect(a).toEqual(b);
	});

	test("keys from different owner scopes never collide", () => {
		const a = firstMateActorKey({
			ownerScope: "alpha",
			projectId: "one",
			threadId: "t",
		});
		const b = firstMateActorKey({
			ownerScope: "beta",
			projectId: "one",
			threadId: "t",
		});
		expect(a).not.toEqual(b);
		expect(a[1]).not.toEqual(b[1]);
	});

	test("keys from different threads in one project never collide", () => {
		const a = firstMateActorKey({
			ownerScope: "alpha",
			projectId: "one",
			threadId: "t-1",
		});
		const b = firstMateActorKey({
			ownerScope: "alpha",
			projectId: "one",
			threadId: "t-2",
		});
		expect(a).not.toEqual(b);
		expect(a[3]).not.toEqual(b[3]);
	});

	test("rejects an empty thread id rather than silently sharing an actor", () => {
		expect(() =>
			firstMateActorKey({
				ownerScope: "alpha",
				projectId: "one",
				threadId: "   ",
			}),
		).toThrow(FirstMateKeyError);
	});
});

describe("normalizeThreadSegment", () => {
	test("normalizes a Slack thread reference to a key segment", () => {
		expect(normalizeThreadSegment("slack:C0ENG:1700000000.000001")).toBe(
			"slack-c0eng-1700000000-000001",
		);
	});

	test("keeps a segment at the length limit unchanged", () => {
		const slug = "a".repeat(KEY_SEGMENT_MAX_LENGTH);
		expect(normalizeThreadSegment(slug)).toBe(slug);
	});

	test("truncates an over-long segment and appends a hash", () => {
		const slug = "a".repeat(100);
		const segment = normalizeThreadSegment(slug);
		expect(segment.length).toBe(KEY_SEGMENT_MAX_LENGTH);
		expect(KEY_SEGMENT_PATTERN.test(segment)).toBe(true);
		expect(segment).toBe(
			`${"a".repeat(KEY_SEGMENT_MAX_LENGTH - 9)}-${shortHash(slug)}`,
		);
	});

	test("two over-long thread references that share a prefix do not collide", () => {
		const prefix = "a".repeat(80);
		const first = normalizeThreadSegment(`${prefix}-one`);
		const second = normalizeThreadSegment(`${prefix}-two`);
		expect(first).not.toBe(second);
		expect(first.length).toBe(KEY_SEGMENT_MAX_LENGTH);
		expect(second.length).toBe(KEY_SEGMENT_MAX_LENGTH);
	});
});

describe("loadGatewayProviderConfig", () => {
	test("returns undefined when the base URL is unset", () => {
		expect(loadGatewayProviderConfig()).toBeUndefined();
	});

	test("returns undefined when the base URL is whitespace", () => {
		process.env[PI_MATE_GATEWAY_BASE_URL_ENV] = "   ";
		expect(loadGatewayProviderConfig()).toBeUndefined();
	});

	test("loads the gateway with defaults for the key var and windows", () => {
		process.env[PI_MATE_GATEWAY_BASE_URL_ENV] =
			"https://gw.example.test/v1";
		process.env[PI_MATE_GATEWAY_MODEL_IDS_ENV] = "minimax-m3, MiniMax-M3";
		const gateway = loadGatewayProviderConfig();
		expect(gateway).toEqual({
			apiKeyEnvVar: DEFAULT_GATEWAY_API_KEY_ENV_VAR,
			baseUrl: "https://gw.example.test/v1",
			contextWindow: DEFAULT_GATEWAY_CONTEXT_WINDOW,
			maxTokens: DEFAULT_GATEWAY_MAX_TOKENS,
			modelIds: ["minimax-m3", "MiniMax-M3"],
		});
	});

	test("accepts an explicit key env var and windows", () => {
		process.env[PI_MATE_GATEWAY_BASE_URL_ENV] =
			"http://gw.internal:8449/v1";
		process.env[PI_MATE_GATEWAY_API_KEY_ENV_VAR_ENV] = "GATEWAY_TOKEN";
		process.env[PI_MATE_GATEWAY_MODEL_IDS_ENV] = "one";
		process.env[PI_MATE_GATEWAY_CONTEXT_WINDOW_ENV] = "200000";
		process.env[PI_MATE_GATEWAY_MAX_TOKENS_ENV] = "4096";
		const gateway = loadGatewayProviderConfig();
		expect(gateway?.apiKeyEnvVar).toBe("GATEWAY_TOKEN");
		expect(gateway?.contextWindow).toBe(200000);
		expect(gateway?.maxTokens).toBe(4096);
	});

	test("rejects a malformed base URL", () => {
		process.env[PI_MATE_GATEWAY_BASE_URL_ENV] = "not-a-url";
		expect(() => loadGatewayProviderConfig()).toThrow(PiMateConfigError);
	});

	test("rejects a non-http(s) base URL", () => {
		process.env[PI_MATE_GATEWAY_BASE_URL_ENV] = "ftp://gw.example.test";
		expect(() => loadGatewayProviderConfig()).toThrow(PiMateConfigError);
	});

	test("rejects a gateway with no model ids", () => {
		process.env[PI_MATE_GATEWAY_BASE_URL_ENV] =
			"https://gw.example.test/v1";
		process.env[PI_MATE_GATEWAY_MODEL_IDS_ENV] = " , ";
		expect(() => loadGatewayProviderConfig()).toThrow(PiMateConfigError);
	});

	test("rejects a non-positive context window", () => {
		process.env[PI_MATE_GATEWAY_BASE_URL_ENV] =
			"https://gw.example.test/v1";
		process.env[PI_MATE_GATEWAY_MODEL_IDS_ENV] = "one";
		process.env[PI_MATE_GATEWAY_CONTEXT_WINDOW_ENV] = "0";
		expect(() => loadGatewayProviderConfig()).toThrow(PiMateConfigError);
	});
});

describe("loadPiMateConfig with a gateway", () => {
	test("defaults the model and allowlist to the gateway models", () => {
		process.env[PI_MATE_GATEWAY_BASE_URL_ENV] =
			"https://gw.example.test/v1";
		process.env[PI_MATE_GATEWAY_MODEL_IDS_ENV] = "minimax-m3,kimi-k3";
		const config = loadPiMateConfig();
		expect(config.model).toBe("gateway/minimax-m3");
		expect(config.scopedModels).toEqual([
			"gateway/minimax-m3",
			"gateway/kimi-k3",
		]);
		expect(config.gateway?.baseUrl).toBe("https://gw.example.test/v1");
	});

	test("an explicit model still wins and must appear in the allowlist", () => {
		process.env[PI_MATE_GATEWAY_BASE_URL_ENV] =
			"https://gw.example.test/v1";
		process.env[PI_MATE_GATEWAY_MODEL_IDS_ENV] = "minimax-m3,kimi-k3";
		process.env[PI_MATE_MODEL_ENV] = "gateway/kimi-k3";
		const config = loadPiMateConfig();
		expect(config.model).toBe("gateway/kimi-k3");

		process.env[PI_MATE_MODEL_ENV] = "gateway/absent";
		expect(() => loadPiMateConfig()).toThrow(PiMateConfigError);
	});

	test("a gateway deployment without the gateway env is unchanged", () => {
		const config = loadPiMateConfig();
		expect(config.gateway).toBeUndefined();
		expect(config.model).toBe(DEFAULT_PI_MATE_MODEL);
	});
});

describe("redactConfigForLog with a gateway", () => {
	test("never includes the gateway base URL", () => {
		process.env[PI_MATE_GATEWAY_BASE_URL_ENV] =
			"https://secret-gw.example.test/v1";
		process.env[PI_MATE_GATEWAY_MODEL_IDS_ENV] = "minimax-m3";
		const config = loadPiMateConfig();
		const dumped = JSON.stringify(redactConfigForLog(config));
		expect(dumped).not.toContain("secret-gw");
		expect(dumped).not.toContain("example.test");
		expect(JSON.parse(dumped)).toMatchObject({
			gatewayEnabled: true,
			gatewayModelCount: 1,
		});
	});

	test("reports the gateway as disabled when unset", () => {
		const config = loadPiMateConfig();
		const redacted = redactConfigForLog(config);
		expect(redacted).toMatchObject({
			gatewayEnabled: false,
			gatewayModelCount: 0,
		});
	});
});

describe("resolveNamespace", () => {
	test("returns the default when the env var is unset", () => {
		expect(resolveNamespace()).toBe(DEFAULT_PI_MATE_NAMESPACE);
	});

	test("returns the default when the env var is empty", () => {
		process.env[PI_MATE_NAMESPACE_ENV] = "   ";
		expect(resolveNamespace()).toBe(DEFAULT_PI_MATE_NAMESPACE);
	});

	test("returns the env value when present", () => {
		process.env[PI_MATE_NAMESPACE_ENV] = "pi-mate-staging";
		expect(resolveNamespace()).toBe("pi-mate-staging");
	});
});

describe("loadPiMateConfig", () => {
	test("returns defaults when no env vars are set", () => {
		const config = loadPiMateConfig();
		expect(config.model).toBe(DEFAULT_PI_MATE_MODEL);
		expect(config.scopedModels).toEqual([...DEFAULT_SCOPED_MODELS]);
		expect(config.apiKeyEnvVars).toEqual([...DEFAULT_API_KEY_ENV_VARS]);
		expect(config.rejectLoopbackEndpoint).toBe(true);
	});

	test("accepts a custom scoped model list that includes the model", () => {
		process.env[PI_MATE_MODEL_ENV] = "openai/gpt-5";
		process.env[PI_MATE_SCOPED_MODELS_ENV] =
			"openai/gpt-5,openai/gpt-5-mini";
		const config = loadPiMateConfig();
		expect(config.model).toBe("openai/gpt-5");
		expect(config.scopedModels).toEqual([
			"openai/gpt-5",
			"openai/gpt-5-mini",
		]);
	});

	test("rejects a model that is not in the scoped list", () => {
		process.env[PI_MATE_MODEL_ENV] = "openai/gpt-5";
		process.env[PI_MATE_SCOPED_MODELS_ENV] = "openai/gpt-5-mini";
		expect(() => loadPiMateConfig()).toThrow(PiMateConfigError);
	});

	test("rejects an empty scoped list", () => {
		process.env[PI_MATE_SCOPED_MODELS_ENV] = "  , , ";
		expect(() => loadPiMateConfig()).toThrow(PiMateConfigError);
	});

	test("accepts custom env var names for API keys", () => {
		process.env[PI_MATE_API_KEY_ENV_VARS_ENV] =
			"PI_MATE_KEY_A,PI_MATE_KEY_B";
		const config = loadPiMateConfig();
		expect(config.apiKeyEnvVars).toEqual([
			"PI_MATE_KEY_A",
			"PI_MATE_KEY_B",
		]);
	});

	test("rejects an empty api key env var list", () => {
		process.env[PI_MATE_API_KEY_ENV_VARS_ENV] = "  , , ";
		expect(() => loadPiMateConfig()).toThrow(PiMateConfigError);
	});
});

describe("redactConfigForLog", () => {
	test("never includes the configured model names", () => {
		process.env[PI_MATE_MODEL_ENV] = "provider-a/model-secret";
		process.env[PI_MATE_SCOPED_MODELS_ENV] =
			"provider-a/model-secret,provider-a/model-other";
		const config = loadPiMateConfig();
		const redacted = redactConfigForLog(config);
		const dumped = JSON.stringify(redacted);
		expect(dumped).not.toContain("model-secret");
		expect(dumped).not.toContain("model-other");
		expect(dumped).not.toContain("provider-a");
		expect(redacted).toMatchObject({
			rejectLoopbackEndpoint: true,
			modelCount: config.scopedModels.length,
			apiKeyEnvVarCount: config.apiKeyEnvVars.length,
		});
	});

	test("never includes the API key env var names verbatim", () => {
		process.env[PI_MATE_API_KEY_ENV_VARS_ENV] = "PI_MATE_SECRET_XYZ";
		const config = loadPiMateConfig();
		const dumped = JSON.stringify(redactConfigForLog(config));
		expect(dumped).not.toContain("PI_MATE_SECRET_XYZ");
	});

	test("never includes sandbox provider URLs, digests, or env var overrides", () => {
		process.env[PI_MATE_SANDBOX_PROVIDER_ENV] = "agentos";
		process.env[PI_MATE_SANDBOX_AGENTOS_SOFTWARE_ENV] =
			"https://example.test/secret-pkg.tgz#digest-deadbeef";
		process.env[PI_MATE_SANDBOX_CWD_ENV] = "/secret/cwd/path";
		process.env[PI_MATE_SANDBOX_DAYTONA_API_KEY_ENV_VAR_ENV] =
			"SECRET_DAYTONA_KEY";
		process.env[PI_MATE_SANDBOX_E2B_API_KEY_ENV_VAR_ENV] = "SECRET_E2B_KEY";
		process.env[PI_MATE_SANDBOX_E2B_TEMPLATE_ENV] = "secret-template";
		const config = loadPiMateConfig();
		const dumped = JSON.stringify(redactConfigForLog(config));
		expect(dumped).not.toContain("secret-pkg");
		expect(dumped).not.toContain("digest-deadbeef");
		expect(dumped).not.toContain("SECRET_DAYTONA_KEY");
		expect(dumped).not.toContain("SECRET_E2B_KEY");
		expect(dumped).not.toContain("secret-template");
		expect(dumped).not.toContain("/secret/cwd/path");
	});
});

describe("KEY_SEGMENT_PATTERN", () => {
	test("accepts typical slug inputs", () => {
		expect(KEY_SEGMENT_PATTERN.test("acme")).toBe(true);
		expect(KEY_SEGMENT_PATTERN.test("acme-co-01")).toBe(true);
		expect(KEY_SEGMENT_PATTERN.test("a1b2c3")).toBe(true);
	});

	test("rejects inputs that start with a hyphen", () => {
		expect(KEY_SEGMENT_PATTERN.test("-acme")).toBe(false);
	});

	test("rejects uppercase inputs", () => {
		expect(KEY_SEGMENT_PATTERN.test("Acme")).toBe(false);
	});

	test("rejects empty input", () => {
		expect(KEY_SEGMENT_PATTERN.test("")).toBe(false);
	});
});

describe("loadSandboxProviderConfig", () => {
	test("defaults to the 'none' provider with no fields populated", () => {
		const sandbox = loadSandboxProviderConfig();
		expect(sandbox.name).toBe(DEFAULT_SANDBOX_PROVIDER_NAME);
		expect(sandbox.cwd).toBeUndefined();
		expect(sandbox.software).toBeUndefined();
		expect(sandbox.daytonaApiKeyEnvVar).toBeUndefined();
		expect(sandbox.e2bApiKeyEnvVar).toBeUndefined();
		expect(sandbox.e2bTemplate).toBeUndefined();
	});

	test("accepts every supported provider name case-insensitively", () => {
		for (const name of SANDBOX_PROVIDER_NAMES) {
			process.env[PI_MATE_SANDBOX_PROVIDER_ENV] = name.toUpperCase();
			expect(loadSandboxProviderConfig().name).toBe(name);
		}
	});

	test("rejects an unknown provider name with PiMateConfigError", () => {
		process.env[PI_MATE_SANDBOX_PROVIDER_ENV] = "vmware";
		expect(() => loadSandboxProviderConfig()).toThrow(PiMateConfigError);
	});

	test("reads cwd when set", () => {
		process.env[PI_MATE_SANDBOX_PROVIDER_ENV] = "agentos";
		process.env[PI_MATE_SANDBOX_CWD_ENV] = "/var/sandbox";
		const sandbox = loadSandboxProviderConfig();
		expect(sandbox.cwd).toBe("/var/sandbox");
	});

	test("parses a single agentOS software URL without digest", () => {
		process.env[PI_MATE_SANDBOX_PROVIDER_ENV] = "agentos";
		process.env[PI_MATE_SANDBOX_AGENTOS_SOFTWARE_ENV] =
			"https://example.test/pkg-a.tgz";
		const sandbox = loadSandboxProviderConfig();
		expect(sandbox.software).toEqual([
			{ url: "https://example.test/pkg-a.tgz" },
		]);
	});

	test("parses a URL#digest pair into a software entry", () => {
		process.env[PI_MATE_SANDBOX_PROVIDER_ENV] = "agentos";
		process.env[PI_MATE_SANDBOX_AGENTOS_SOFTWARE_ENV] =
			"https://example.test/pkg-a.tgz#sha256-abc";
		const sandbox = loadSandboxProviderConfig();
		expect(sandbox.software).toEqual([
			{ url: "https://example.test/pkg-a.tgz", digest: "sha256-abc" },
		]);
	});

	test("parses a comma-separated list of software entries", () => {
		process.env[PI_MATE_SANDBOX_PROVIDER_ENV] = "agentos";
		process.env[PI_MATE_SANDBOX_AGENTOS_SOFTWARE_ENV] =
			"https://example.test/a.tgz,https://example.test/b.tgz#sha256-def";
		const sandbox = loadSandboxProviderConfig();
		expect(sandbox.software).toEqual([
			{ url: "https://example.test/a.tgz" },
			{ url: "https://example.test/b.tgz", digest: "sha256-def" },
		]);
	});

	test("rejects an agentOS software entry that has a digest but no URL", () => {
		process.env[PI_MATE_SANDBOX_PROVIDER_ENV] = "agentos";
		process.env[PI_MATE_SANDBOX_AGENTOS_SOFTWARE_ENV] = "#sha256-abc";
		expect(() => loadSandboxProviderConfig()).toThrow(PiMateConfigError);
	});

	test("rejects an agentOS software entry whose digest is empty", () => {
		process.env[PI_MATE_SANDBOX_PROVIDER_ENV] = "agentos";
		process.env[PI_MATE_SANDBOX_AGENTOS_SOFTWARE_ENV] =
			"https://example.test/pkg.tgz#";
		expect(() => loadSandboxProviderConfig()).toThrow(PiMateConfigError);
	});

	test("ignores agentOS software entries when a non-agentOS provider is selected", () => {
		process.env[PI_MATE_SANDBOX_PROVIDER_ENV] = "daytona";
		process.env[PI_MATE_SANDBOX_AGENTOS_SOFTWARE_ENV] =
			"https://example.test/pkg.tgz";
		const sandbox = loadSandboxProviderConfig();
		expect(sandbox.software).toBeUndefined();
	});

	test("reads provider-specific env var overrides", () => {
		process.env[PI_MATE_SANDBOX_PROVIDER_ENV] = "daytona";
		process.env[PI_MATE_SANDBOX_DAYTONA_API_KEY_ENV_VAR_ENV] =
			"CUSTOM_DAYTONA_KEY";
		const sandbox = loadSandboxProviderConfig();
		expect(sandbox.daytonaApiKeyEnvVar).toBe("CUSTOM_DAYTONA_KEY");

		process.env[PI_MATE_SANDBOX_PROVIDER_ENV] = "e2b";
		process.env[PI_MATE_SANDBOX_E2B_API_KEY_ENV_VAR_ENV] = "CUSTOM_E2B_KEY";
		process.env[PI_MATE_SANDBOX_E2B_TEMPLATE_ENV] = "node";
		const e2bSandbox = loadSandboxProviderConfig();
		expect(e2bSandbox.e2bApiKeyEnvVar).toBe("CUSTOM_E2B_KEY");
		expect(e2bSandbox.e2bTemplate).toBe("node");
	});
});

describe("redactSandboxProviderConfig", () => {
	test("names the provider, counts software, and reports only boolean flags for credentials", () => {
		const redacted = redactSandboxProviderConfig({
			name: "agentos",
			cwd: "/var/secret",
			software: [
				{ url: "https://example.test/pkg.tgz", digest: "sha256-abc" },
			],
			daytonaApiKeyEnvVar: "SECRET_DAYTONA_KEY",
			e2bApiKeyEnvVar: "SECRET_E2B_KEY",
			e2bTemplate: "secret-template",
		});
		const dumped = JSON.stringify(redacted);
		expect(redacted.name).toBe("agentos");
		expect(redacted.softwareCount).toBe(1);
		expect(redacted.hasDaytonaApiKeyEnvVar).toBe(true);
		expect(redacted.hasE2bApiKeyEnvVar).toBe(true);
		expect(redacted.hasE2bTemplate).toBe(true);
		expect(redacted.hasCwd).toBe(true);
		expect(dumped).not.toContain("SECRET_DAYTONA_KEY");
		expect(dumped).not.toContain("SECRET_E2B_KEY");
		expect(dumped).not.toContain("secret-template");
		expect(dumped).not.toContain("/var/secret");
		expect(dumped).not.toContain("example.test");
	});

	test("omits the cwd flag when no cwd is set", () => {
		const redacted = redactSandboxProviderConfig({ name: "none" });
		expect(redacted).not.toHaveProperty("hasCwd");
		expect(redacted.softwareCount).toBe(0);
		expect(redacted.hasDaytonaApiKeyEnvVar).toBe(false);
		expect(redacted.hasE2bApiKeyEnvVar).toBe(false);
		expect(redacted.hasE2bTemplate).toBe(false);
	});
});
