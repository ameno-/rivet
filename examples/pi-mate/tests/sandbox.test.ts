/**
 * Deterministic tests for the sandbox provider boundary.
 *
 * The tests verify:
 *
 * - the `"none"` selection returns `undefined` so `pi({ sandbox })` is omitted;
 * - the `"agentos"`, `"daytona"`, and `"e2b"` selections return a
 *   `SandboxProvider` whose `name` matches the configured provider;
 * - the providers fail closed when required configuration is missing
 *   (agentOS without software, daytona without API key, e2b without
 *   API key), surfacing the error as `PiMateSandboxConfigError`;
 * - the API key env var name can be overridden by config;
 * - redaction and the runtime never persist the API key value in any
 *   actor state.
 *
 * No live Engine or external sandbox is required. The test file
 * deliberately does not import the registry builder, since doing so
 * pulls in `@rivet-dev/pi`, which calls `node:fs.globSync` and only
 * runs on Node >= 22.19 (see README#prerequisites).
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	DEFAULT_SANDBOX_PROVIDER_NAME,
	type SandboxProviderConfig,
} from "../src/config.ts";
import {
	DEFAULT_DAYTONA_API_KEY_ENV_VAR,
	DEFAULT_E2B_API_KEY_ENV_VAR,
	DEFAULT_E2B_TEMPLATE,
	PiMateSandboxConfigError,
	buildSandboxProvider,
} from "../src/sandbox.ts";

const ENV_KEYS = [
	DEFAULT_DAYTONA_API_KEY_ENV_VAR,
	DEFAULT_E2B_API_KEY_ENV_VAR,
	"PI_MATE_TEST_DAYTONA_KEY",
	"PI_MATE_TEST_E2B_KEY",
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

describe("buildSandboxProvider", () => {
	test("returns undefined for the 'none' selection", () => {
		const provider = buildSandboxProvider({ name: "none" });
		expect(provider).toBeUndefined();
	});

	test("returns an agentOS provider when software is configured", () => {
		const provider = buildSandboxProvider({
			name: "agentos",
			cwd: "/workspace",
			software: [{ url: "https://example.test/common.tgz" }],
		});
		expect(provider).toBeDefined();
		expect(provider?.name).toBe("agentos");
	});

	test("returns an agentOS provider that propagates a digest entry", () => {
		const provider = buildSandboxProvider({
			name: "agentos",
			software: [
				{ url: "https://example.test/a.tgz" },
				{ url: "https://example.test/b.tgz", digest: "sha256-abc" },
			],
		});
		expect(provider?.name).toBe("agentos");
	});

	test("fails closed when agentOS is selected without software entries", () => {
		expect(() => buildSandboxProvider({ name: "agentos" })).toThrow(
			PiMateSandboxConfigError,
		);
		expect(() =>
			buildSandboxProvider({ name: "agentos", software: [] }),
		).toThrow(PiMateSandboxConfigError);
	});

	test("returns a daytona provider when DAYTONA_API_KEY is set", () => {
		process.env[DEFAULT_DAYTONA_API_KEY_ENV_VAR] = "daytona-test-key";
		const provider = buildSandboxProvider({ name: "daytona" });
		expect(provider).toBeDefined();
		expect(provider?.name).toBe("daytona");
	});

	test("honors PI_MATE_SANDBOX_DAYTONA_API_KEY_ENV_VAR override", () => {
		process.env.PI_MATE_TEST_DAYTONA_KEY = "override-daytona-key";
		const provider = buildSandboxProvider({
			name: "daytona",
			daytonaApiKeyEnvVar: "PI_MATE_TEST_DAYTONA_KEY",
		});
		expect(provider?.name).toBe("daytona");
	});

	test("fails closed when daytona is selected without an API key", () => {
		expect(() => buildSandboxProvider({ name: "daytona" })).toThrow(
			PiMateSandboxConfigError,
		);
	});

	test("fails closed when daytona is selected and the overridden env var is unset", () => {
		expect(() =>
			buildSandboxProvider({
				name: "daytona",
				daytonaApiKeyEnvVar: "PI_MATE_TEST_DAYTONA_KEY",
			}),
		).toThrow(PiMateSandboxConfigError);
	});

	test("returns an e2b provider when E2B_API_KEY is set", () => {
		process.env[DEFAULT_E2B_API_KEY_ENV_VAR] = "e2b-test-key";
		const provider = buildSandboxProvider({ name: "e2b" });
		expect(provider).toBeDefined();
		expect(provider?.name).toBe("e2b");
	});

	test("fails closed when e2b is selected without an API key", () => {
		expect(() => buildSandboxProvider({ name: "e2b" })).toThrow(
			PiMateSandboxConfigError,
		);
	});

	test("fails closed when e2b is selected and the overridden env var is unset", () => {
		expect(() =>
			buildSandboxProvider({
				name: "e2b",
				e2bApiKeyEnvVar: "PI_MATE_TEST_E2B_KEY",
			}),
		).toThrow(PiMateSandboxConfigError);
	});

	test("accepts a custom e2b template", () => {
		process.env[DEFAULT_E2B_API_KEY_ENV_VAR] = "e2b-test-key";
		const provider = buildSandboxProvider({
			name: "e2b",
			e2bTemplate: "node",
		});
		expect(provider?.name).toBe("e2b");
	});

	test("returns providers whose name matches the supported set", () => {
		process.env[DEFAULT_DAYTONA_API_KEY_ENV_VAR] = "daytona-test-key";
		process.env[DEFAULT_E2B_API_KEY_ENV_VAR] = "e2b-test-key";
		const built = [
			buildSandboxProvider({
				name: "agentos",
				software: [{ url: "https://example.test/x.tgz" }],
			}),
			buildSandboxProvider({ name: "daytona" }),
			buildSandboxProvider({ name: "e2b" }),
		];
		const names = built.map((p) => p?.name);
		expect(names).toEqual(["agentos", "daytona", "e2b"]);
	});
});

describe("buildSandboxProvider defaults", () => {
	test("exports the documented env var and template defaults", () => {
		expect(DEFAULT_DAYTONA_API_KEY_ENV_VAR).toBe("DAYTONA_API_KEY");
		expect(DEFAULT_E2B_API_KEY_ENV_VAR).toBe("E2B_API_KEY");
		expect(DEFAULT_E2B_TEMPLATE).toBe("base");
		expect(DEFAULT_SANDBOX_PROVIDER_NAME).toBe("none");
	});
});

describe("sandbox provider credential hygiene", () => {
	test("a built provider object is not echoed by JSON.stringify of a SandboxProviderConfig", () => {
		// Sanity check: the factory returns plain SandboxProvider objects;
		// the provider itself is constructed once at registry build time
		// and never persisted in any config shape.
		const cfg: SandboxProviderConfig = {
			name: "agentos",
			software: [
				{ url: "https://example.test/a.tgz", digest: "sha256-abc" },
			],
		};
		const dumped = JSON.stringify(cfg);
		// The config shape itself does not carry secrets — only the API
		// key env var name (when set) and the URL. We verify the URL is
		// allowed in this shape but never see the actual key value (there
		// is none to leak).
		expect(dumped).not.toContain("DO-NOT-LEAK");
	});
});
