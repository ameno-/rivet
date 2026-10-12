/**
 * Deterministic unit tests for the config-gated faux proof provider.
 *
 * The faux provider exists so the live durability harness can drive every
 * lifecycle phase against a real Rivet Engine without real model
 * credentials. These tests pin the contract that keeps that honest:
 *
 * - the gate is fail-closed and off by default;
 * - faux mode forces the model allowlist to the proof models;
 * - the sentinel credential is served to the proof provider only, so it
 *   can never satisfy a real provider's credential lookup;
 * - reply routing is deterministic: `slow` prompts stream slowly,
 *   everything else echoes the serving model id;
 * - the mode is visible in redacted startup logs so a faux run can
 *   never masquerade as the real provider path.
 *
 * Nothing here touches a live Engine or opens a network connection.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildPiMateRegistry } from "../src/actors.ts";
import {
	PI_MATE_LIVE_PROOF_FAUX_PROVIDER_ENV,
	PI_MATE_MODEL_ENV,
	PI_MATE_SCOPED_MODELS_ENV,
	PROOF_MODEL_IDS,
	PROOF_PROVIDER_NAME,
	loadPiMateConfig,
	proofScopedModels,
	readFauxProofProviderEnabled,
	redactConfigForLog,
} from "../src/config.ts";
import {
	PROOF_SENTINEL_API_KEY,
	buildProofCredentialSource,
	buildProofProviderConfig,
	planProofReply,
} from "../src/proof-provider.ts";

const ENV_KEYS = [
	PI_MATE_LIVE_PROOF_FAUX_PROVIDER_ENV,
	PI_MATE_MODEL_ENV,
	PI_MATE_SCOPED_MODELS_ENV,
	"PI_MATE_ANTHROPIC_API_KEY",
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

/** Enable faux mode on the live process env for one test. */
function enableFauxMode(value = "1"): void {
	process.env[PI_MATE_LIVE_PROOF_FAUX_PROVIDER_ENV] = value;
}

describe("readFauxProofProviderEnabled", () => {
	test("is off by default and fail-closed for junk values", () => {
		expect(readFauxProofProviderEnabled({})).toBe(false);
		expect(
			readFauxProofProviderEnabled({
				[PI_MATE_LIVE_PROOF_FAUX_PROVIDER_ENV]: "",
			}),
		).toBe(false);
		expect(
			readFauxProofProviderEnabled({
				[PI_MATE_LIVE_PROOF_FAUX_PROVIDER_ENV]: "yes",
			}),
		).toBe(false);
	});

	test("accepts the documented opt-in values case-insensitively", () => {
		expect(
			readFauxProofProviderEnabled({
				[PI_MATE_LIVE_PROOF_FAUX_PROVIDER_ENV]: "1",
			}),
		).toBe(true);
		expect(
			readFauxProofProviderEnabled({
				[PI_MATE_LIVE_PROOF_FAUX_PROVIDER_ENV]: "true",
			}),
		).toBe(true);
		expect(
			readFauxProofProviderEnabled({
				[PI_MATE_LIVE_PROOF_FAUX_PROVIDER_ENV]: " TRUE ",
			}),
		).toBe(true);
	});
});

describe("loadPiMateConfig in faux mode", () => {
	test("forces the proof models regardless of the env model vars", () => {
		enableFauxMode();
		process.env[PI_MATE_MODEL_ENV] = "anthropic/claude-sonnet-4-6";
		process.env[PI_MATE_SCOPED_MODELS_ENV] = "anthropic/claude-sonnet-4-6";
		const config = loadPiMateConfig();
		expect(config.fauxProofProvider).toBe(true);
		expect(config.model).toBe(
			`${PROOF_PROVIDER_NAME}/${PROOF_MODEL_IDS[0]}`,
		);
		expect(config.scopedModels).toEqual(proofScopedModels());
	});

	test("leaves the real provider path untouched when the gate is off", () => {
		const config = loadPiMateConfig();
		expect(config.fauxProofProvider).toBe(false);
		expect(config.model).toBe("anthropic/claude-sonnet-4-6");
	});

	test("the proof allowlist contains the switch target", () => {
		enableFauxMode();
		const config = loadPiMateConfig();
		expect(config.scopedModels).toContain(
			`${PROOF_PROVIDER_NAME}/${PROOF_MODEL_IDS[1]}`,
		);
	});
});

describe("redactConfigForLog", () => {
	test("surfaces the faux mode flag and never echoes model ids", () => {
		enableFauxMode();
		const redacted = redactConfigForLog(loadPiMateConfig());
		expect(redacted.fauxProofProvider).toBe(true);
		expect(redacted.modelCount).toBe(proofScopedModels().length);
		expect(JSON.stringify(redacted)).not.toContain("proof-model");
	});

	test("records the real provider path when the gate is off", () => {
		const redacted = redactConfigForLog(loadPiMateConfig());
		expect(redacted.fauxProofProvider).toBe(false);
	});
});

describe("buildProofProviderConfig", () => {
	test("registers every proof model under the proof provider", () => {
		const provider = buildProofProviderConfig();
		expect(provider.api).toBe("mock");
		expect(provider.baseUrl).toBe("http://localhost:0");
		expect(provider.models?.map((model) => model.id)).toEqual([
			...PROOF_MODEL_IDS,
		]);
		expect(typeof provider.streamSimple).toBe("function");
	});
});

describe("planProofReply", () => {
	test("routes slow prompts to a long streaming reply", () => {
		const plan = planProofReply(
			"live-proof slow steering prompt",
			"proof-model",
		);
		expect(plan.slow).toBe(true);
		expect(plan.text.length).toBeGreaterThan(200);
	});

	test("the word slow must match on word boundaries", () => {
		expect(planProofReply("slowly now", "proof-model").slow).toBe(false);
		expect(planProofReply("make it SLOW please", "proof-model").slow).toBe(
			true,
		);
	});

	test("immediate replies echo the serving model id", () => {
		const plan = planProofReply("hello there", "proof-model-2");
		expect(plan.slow).toBe(false);
		expect(plan.text).toContain(
			"proof model proof-model-2 acknowledges: hello there",
		);
	});

	test("clips pathologically long prompts deterministically", () => {
		const longText = "x".repeat(500);
		const plan = planProofReply(longText, "proof-model");
		expect(plan.slow).toBe(false);
		expect(plan.text.length).toBeLessThan(
			`proof model proof-model acknowledges: ${longText}`.length,
		);
		expect(plan.text.endsWith("...")).toBe(true);
	});

	test("an empty prompt still receives an immediate reply", () => {
		const plan = planProofReply("", "proof-model");
		expect(plan.slow).toBe(false);
		expect(plan.text).toContain("acknowledges");
	});
});

describe("buildProofCredentialSource", () => {
	test("serves the labeled sentinel to the proof provider", async () => {
		const source = buildProofCredentialSource();
		const entries = await source.list();
		expect(entries).toEqual([
			{ providerId: PROOF_PROVIDER_NAME, type: "api_key" },
		]);
		const credential = await source.read(PROOF_PROVIDER_NAME);
		expect(credential).toEqual({
			type: "api_key",
			key: PROOF_SENTINEL_API_KEY,
		});
		const refreshed = await source.refresh(PROOF_PROVIDER_NAME);
		expect(refreshed).toEqual(credential);
	});

	test("never hands the sentinel to a real provider", async () => {
		const source = buildProofCredentialSource();
		// Even with a real-looking key in the environment, the source must
		// not serve the sentinel (or anything else) to a real provider.
		process.env.PI_MATE_ANTHROPIC_API_KEY = "real-looking-key";
		expect(await source.read("anthropic")).toBeUndefined();
		expect(await source.refresh("anthropic")).toBeUndefined();
	});
});

describe("registry wiring in faux mode", () => {
	test("the registry builds and parses with the proof provider wired", () => {
		enableFauxMode();
		const config = loadPiMateConfig();
		const registry = buildPiMateRegistry(config);
		const parsed = registry.parseConfig();
		expect(Object.keys(parsed.use)).toContain("firstMate");
		// The proof provider is consumed by the pi() session-options
		// closure (splitConfig removes it from the parsed actor config),
		// so its presence is asserted by config + provider units above;
		// this smoke test pins that the wiring never breaks registry build.
		expect(parsed.use.firstMate).toBeDefined();
	});
});
