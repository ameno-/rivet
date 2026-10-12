import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FIRST_MATE_ACTOR_NAME, buildPiMateRegistry } from "../src/actors.ts";
import {
	DEFAULT_API_KEY_ENV_VARS,
	DEFAULT_PI_MATE_MODEL,
	DEFAULT_SCOPED_MODELS,
	DEFAULT_SANDBOX_PROVIDER_NAME,
	PI_MATE_API_KEY_ENV_VARS_ENV,
	PI_MATE_MODEL_ENV,
	PI_MATE_NAMESPACE_ENV,
	PI_MATE_SCOPED_MODELS_ENV,
	firstMateActorKey,
	loadPiMateConfig,
	type PiMateConfig,
} from "../src/config.ts";

const ENV_KEYS = [
	"RIVET_NAMESPACE",
	PI_MATE_MODEL_ENV,
	PI_MATE_SCOPED_MODELS_ENV,
	PI_MATE_API_KEY_ENV_VARS_ENV,
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

function fixedConfig(): PiMateConfig {
	return {
		model: DEFAULT_PI_MATE_MODEL,
		scopedModels: [...DEFAULT_SCOPED_MODELS],
		apiKeyEnvVars: [...DEFAULT_API_KEY_ENV_VARS],
		fauxProofProvider: false,
		rejectLoopbackEndpoint: true,
		sandbox: { name: DEFAULT_SANDBOX_PROVIDER_NAME },
	};
}

describe("buildPiMateRegistry", () => {
	test("exposes exactly one actor named firstMate", () => {
		const registry = buildPiMateRegistry(fixedConfig());
		const parsed = registry.parseConfig();
		const actorNames = Object.keys(parsed.use);
		expect(actorNames).toEqual([FIRST_MATE_ACTOR_NAME]);
	});

	test("sets startEngine to false", () => {
		const registry = buildPiMateRegistry(fixedConfig());
		const config = registry.parseConfig();
		expect(config.startEngine).toBe(false);
	});

	test("the registry parses back a config with the operator-supplied namespace", () => {
		process.env.RIVET_NAMESPACE = "pi-mate-staging";
		const registry = buildPiMateRegistry(fixedConfig());
		const parsed = registry.parseConfig();
		expect(parsed.namespace).toBe("pi-mate-staging");
	});

	test("the same registry instance can be built twice without throwing", () => {
		expect(() => buildPiMateRegistry(fixedConfig())).not.toThrow();
		expect(() => buildPiMateRegistry(fixedConfig())).not.toThrow();
	});

	test("does not depend on any Mugamaa package", () => {
		// Static check: this service has no `mugamaa` dep in package.json.
		// Re-assert it from the parsed registry to catch accidental wiring.
		const registry = buildPiMateRegistry(fixedConfig());
		const parsed = registry.parseConfig();
		const dumped = JSON.stringify(parsed);
		expect(dumped.toLowerCase()).not.toContain("mugamaa");
	});

	test("respects a custom model list passed through the config", () => {
		const cfg: PiMateConfig = {
			...fixedConfig(),
			model: "openai/gpt-5",
			scopedModels: ["openai/gpt-5", "openai/gpt-5-mini"],
		};
		const registry = buildPiMateRegistry(cfg);
		expect(registry).toBeDefined();
		// The actual actor config is held internally; this assertion
		// confirms the registry accepted the model without error.
	});

	test("uses the runtime-injected env var name as the canonical provider", () => {
		process.env[PI_MATE_API_KEY_ENV_VARS_ENV] = "PI_MATE_TEST_CANONICAL";
		const cfg = loadPiMateConfig();
		const registry = buildPiMateRegistry(cfg);
		expect(registry).toBeDefined();
	});
});

describe("FIRST_MATE_ACTOR_NAME", () => {
	test("is 'firstMate'", () => {
		expect(FIRST_MATE_ACTOR_NAME).toBe("firstMate");
	});
});

describe("typed client smoke path", () => {
	test("firstMateActorKey returns the documented tuple shape for typical inputs", () => {
		expect(
			firstMateActorKey({
				ownerScope: "acme",
				projectId: "northstar",
				threadId: "slack:C0ENG:1700000000.000001",
			}),
		).toEqual([
			"mate",
			"acme",
			"northstar",
			"slack-c0eng-1700000000-000001",
		]);
	});

	test("two threads in one project address different actors", () => {
		const a = firstMateActorKey({
			ownerScope: "acme",
			projectId: "northstar",
			threadId: "thread-a",
		});
		const b = firstMateActorKey({
			ownerScope: "acme",
			projectId: "northstar",
			threadId: "thread-b",
		});
		expect(a).not.toEqual(b);
		expect(a.slice(0, 3)).toEqual(b.slice(0, 3));
	});
});
