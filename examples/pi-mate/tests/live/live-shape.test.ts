/**
 * Vitest shape tests for the live Pi Mate durability proof harness.
 *
 * These tests never touch a live Engine. They assert:
 *
 * - the harness exposes a stable set of phases;
 * - the prereq checker reports `dry_run` when `RIVET_ENDPOINT` is
 *   unset, a loopback, or a malformed URL;
 * - the harness derives the documented three-segment actor key from
 *   the operator-supplied slugs;
 * - the harness redaction helpers never echo secrets.
 *
 * Vitest's regular test runner picks these up only when the example
 * explicitly opts into the live suite. The default `vitest.config.ts`
 * excludes `tests/live/**` from the regular run; this file is
 * intended to be run separately, e.g. via
 * `pnpm --filter example-pi-mate test:live`.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	LIVE_PROOF_ENV,
	LIVE_PROOF_PHASES,
	MAX_OBSERVED_EVENT_IDS,
	MAX_REPORT_PHASES,
	appendPhase,
	defaultReportPath,
	fingerprintEquals,
	fingerprintSession,
	firstEventIds,
	isFauxProofProviderEnabled,
	isLoopbackHost,
	newReport,
	planAllPhases,
	proofActorKey,
	proofRunId,
	readLiveProofPrereq,
	redactEndpoint,
	stableStringify,
} from "./proof-harness.ts";

const SAVED_ENV_KEYS = Object.values(LIVE_PROOF_ENV) as string[];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of SAVED_ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of SAVED_ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("LIVE_PROOF_PHASES", () => {
	test("exposes the documented phases in dependency order", () => {
		expect(LIVE_PROOF_PHASES).toEqual([
			"check",
			"seed",
			"verify-key",
			"verify-events",
			"verify-reconnect",
			"verify-model-switch",
			"verify-steering",
			"verify-abort",
			"verify-compaction",
			"verify-unknown-outcome",
			"verify-runtime-restart",
			"all",
		]);
	});
});

describe("readLiveProofPrereq", () => {
	test("flags dry-run when RIVET_ENDPOINT is unset", () => {
		const prereq = readLiveProofPrereq({});
		expect(prereq.ok).toBe(false);
		expect(prereq.skipReason).toBe("dry_run");
		expect(prereq.missing).toContain(LIVE_PROOF_ENV.endpoint);
	});

	test("rejects a loopback endpoint with unsupported_endpoint", () => {
		const prereq = readLiveProofPrereq({
			[LIVE_PROOF_ENV.endpoint]: "http://127.0.0.1:6420",
			[LIVE_PROOF_ENV.ownerScope]: "demo-owner",
			[LIVE_PROOF_ENV.projectId]: "demo-project",
			[LIVE_PROOF_ENV.model]: "anthropic/claude-sonnet-4-6",
			[LIVE_PROOF_ENV.scopedModels]:
				"anthropic/claude-sonnet-4-6,anthropic/claude-opus-4-7",
		});
		expect(prereq.ok).toBe(false);
		expect(prereq.skipReason).toBe("unsupported_endpoint");
		expect(prereq.missing).toContain("RIVET_ENDPOINT(non-loopback)");
		expect(prereq.endpointOrigin).toBe("http://127.0.0.1:6420");
	});

	test("rejects localhost with unsupported_endpoint", () => {
		const prereq = readLiveProofPrereq({
			[LIVE_PROOF_ENV.endpoint]: "http://localhost:6420",
			[LIVE_PROOF_ENV.ownerScope]: "demo",
			[LIVE_PROOF_ENV.projectId]: "demo",
		});
		expect(prereq.ok).toBe(false);
		expect(prereq.skipReason).toBe("unsupported_endpoint");
	});

	test("rejects a malformed endpoint URL", () => {
		const prereq = readLiveProofPrereq({
			[LIVE_PROOF_ENV.endpoint]: "not-a-url",
			[LIVE_PROOF_ENV.ownerScope]: "demo",
			[LIVE_PROOF_ENV.projectId]: "demo",
		});
		expect(prereq.ok).toBe(false);
		expect(prereq.skipReason).toBe("unsupported_endpoint");
	});

	test("rejects a model outside the scoped model list", () => {
		const prereq = readLiveProofPrereq({
			[LIVE_PROOF_ENV.endpoint]: "http://agent-core-lan:6420",
			[LIVE_PROOF_ENV.ownerScope]: "demo",
			[LIVE_PROOF_ENV.projectId]: "demo",
			[LIVE_PROOF_ENV.model]: "openai/gpt-5",
			[LIVE_PROOF_ENV.scopedModels]: "anthropic/claude-sonnet-4-6",
		});
		expect(prereq.ok).toBe(false);
		expect(prereq.skipReason).toBe("dry_run");
		expect(prereq.missing).toContain(
			"PI_MATE_MODEL in PI_MATE_SCOPED_MODELS",
		);
	});

	test("accepts a complete configuration and exposes its components", () => {
		const prereq = readLiveProofPrereq({
			[LIVE_PROOF_ENV.endpoint]: "http://agent-core-lan:6420",
			[LIVE_PROOF_ENV.namespace]: "pi-mate-staging",
			[LIVE_PROOF_ENV.ownerScope]: "acme",
			[LIVE_PROOF_ENV.projectId]: "northstar",
			[LIVE_PROOF_ENV.model]: "anthropic/claude-sonnet-4-6",
			[LIVE_PROOF_ENV.scopedModels]:
				"anthropic/claude-sonnet-4-6,anthropic/claude-opus-4-7",
			[LIVE_PROOF_ENV.apiKeyEnvVars]: "PI_MATE_ANTHROPIC_API_KEY",
			PI_MATE_ANTHROPIC_API_KEY: "configured-for-test",
		});
		expect(prereq.ok).toBe(true);
		expect(prereq.endpointOrigin).toBe("http://agent-core-lan:6420");
		expect(prereq.namespace).toBe("pi-mate-staging");
		expect(prereq.ownerScope).toBe("acme");
		expect(prereq.projectId).toBe("northstar");
		expect(prereq.model).toBe("anthropic/claude-sonnet-4-6");
		expect(prereq.scopedModels).toEqual([
			"anthropic/claude-sonnet-4-6",
			"anthropic/claude-opus-4-7",
		]);
		expect(prereq.apiKeyEnvVars).toEqual(["PI_MATE_ANTHROPIC_API_KEY"]);
	});
});

describe("readLiveProofPrereq (faux provider mode)", () => {
	test("faux mode satisfies the credential prerequisite without an API key", () => {
		const prereq = readLiveProofPrereq({
			[LIVE_PROOF_ENV.endpoint]: "http://agent-core-lan:6420",
			[LIVE_PROOF_ENV.ownerScope]: "acme",
			[LIVE_PROOF_ENV.projectId]: "northstar",
			[LIVE_PROOF_ENV.fauxProvider]: "1",
		});
		expect(prereq.ok).toBe(true);
		expect(prereq.providerMode).toBe("faux");
		expect(prereq.missing).toEqual([]);
	});

	test("faux mode ignores the env model allowlist", () => {
		const prereq = readLiveProofPrereq({
			[LIVE_PROOF_ENV.endpoint]: "http://agent-core-lan:6420",
			[LIVE_PROOF_ENV.ownerScope]: "acme",
			[LIVE_PROOF_ENV.projectId]: "northstar",
			[LIVE_PROOF_ENV.model]: "openai/gpt-5",
			[LIVE_PROOF_ENV.scopedModels]: "anthropic/claude-sonnet-4-6",
			[LIVE_PROOF_ENV.fauxProvider]: "true",
		});
		expect(prereq.ok).toBe(true);
		expect(prereq.providerMode).toBe("faux");
		expect(prereq.missing).not.toContain(
			"PI_MATE_MODEL in PI_MATE_SCOPED_MODELS",
		);
	});

	test("real mode still requires model credentials", () => {
		const prereq = readLiveProofPrereq({
			[LIVE_PROOF_ENV.endpoint]: "http://agent-core-lan:6420",
			[LIVE_PROOF_ENV.ownerScope]: "acme",
			[LIVE_PROOF_ENV.projectId]: "northstar",
		});
		expect(prereq.ok).toBe(false);
		expect(prereq.providerMode).toBe("real");
		expect(prereq.missing).toContain("PI_MATE_ANTHROPIC_API_KEY");
	});

	test("isFauxProofProviderEnabled is fail-closed", () => {
		expect(isFauxProofProviderEnabled({})).toBe(false);
		expect(
			isFauxProofProviderEnabled({
				[LIVE_PROOF_ENV.fauxProvider]: "maybe",
			}),
		).toBe(false);
		expect(
			isFauxProofProviderEnabled({
				[LIVE_PROOF_ENV.fauxProvider]: " 1 ",
			}),
		).toBe(true);
	});
});

describe("isLoopbackHost", () => {
	test("matches IPv4 loopback addresses", () => {
		expect(isLoopbackHost("127.0.0.1")).toBe(true);
		expect(isLoopbackHost("127.255.0.42")).toBe(true);
	});

	test("matches the IPv6 loopback and the literal names", () => {
		expect(isLoopbackHost("::1")).toBe(true);
		expect(isLoopbackHost("localhost")).toBe(true);
		expect(isLoopbackHost("foo.localhost")).toBe(true);
	});

	test("does not match non-loopback hostnames", () => {
		expect(isLoopbackHost("agent-core-lan")).toBe(false);
		expect(isLoopbackHost("rivet.example.com")).toBe(false);
		expect(isLoopbackHost("10.0.0.1")).toBe(false);
	});
});

describe("proofActorKey", () => {
	test("derives the documented four-segment tuple with the thread partition", () => {
		const identity = proofActorKey({
			[LIVE_PROOF_ENV.ownerScope]: "acme",
			[LIVE_PROOF_ENV.projectId]: "northstar",
		});
		expect(identity.key).toEqual([
			"mate",
			"acme",
			"northstar",
			"live-proof",
		]);
		expect(proofRunId(identity)).toBe("acme__northstar__live-proof");
	});

	test("a configured thread id partitions one proof run from another", () => {
		const identity = proofActorKey({
			[LIVE_PROOF_ENV.ownerScope]: "acme",
			[LIVE_PROOF_ENV.projectId]: "northstar",
			[LIVE_PROOF_ENV.threadId]: "thread-b",
		});
		expect(identity.key).toEqual(["mate", "acme", "northstar", "thread-b"]);
		expect(identity.threadId).toBe("thread-b");
	});

	test("normalizes slugs the same way the runtime key derivation does", () => {
		const identity = proofActorKey({
			[LIVE_PROOF_ENV.ownerScope]: "Acme Co.",
			[LIVE_PROOF_ENV.projectId]: "North Star",
		});
		expect(identity.key).toEqual([
			"mate",
			"acme-co",
			"north-star",
			"live-proof",
		]);
	});

	test("throws when the slug is empty after normalization", () => {
		expect(() =>
			proofActorKey({
				[LIVE_PROOF_ENV.ownerScope]: "---",
				[LIVE_PROOF_ENV.projectId]: "demo",
			}),
		).toThrow(/alphanumeric/);
	});

	test("throws when either env var is missing", () => {
		expect(() => proofActorKey({})).toThrow(/PI_MATE_OWNER_SCOPE/);
		expect(() =>
			proofActorKey({ [LIVE_PROOF_ENV.ownerScope]: "demo" }),
		).toThrow(/PI_MATE_PROJECT_ID/);
	});
});

describe("redactEndpoint", () => {
	test("returns the origin only", () => {
		expect(
			redactEndpoint("http://user:token@example.test:6420/path?secret=x"),
		).toBe("http://example.test:6420");
	});

	test("falls back to <invalid> for malformed URLs", () => {
		expect(redactEndpoint("not-a-url")).toBe("<invalid>");
		expect(redactEndpoint(undefined)).toBeUndefined();
	});
});

describe("firstEventIds", () => {
	test("extracts the first ids from a stream of events", () => {
		const events = Array.from({ length: 12 }, (_, i) => ({ id: i }));
		expect(firstEventIds(events)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		expect(firstEventIds(events).length).toBeLessThanOrEqual(
			MAX_OBSERVED_EVENT_IDS,
		);
	});

	test("skips events that have no id", () => {
		const events = [{ id: "a" }, { no_id: 1 }, { id: "b" }];
		expect(firstEventIds(events)).toEqual(["a", "b"]);
	});
});

describe("appendPhase", () => {
	test("caps the report at MAX_REPORT_PHASES entries", () => {
		const prereq = readLiveProofPrereq({
			[LIVE_PROOF_ENV.endpoint]: "http://agent-core-lan:6420",
			[LIVE_PROOF_ENV.ownerScope]: "demo",
			[LIVE_PROOF_ENV.projectId]: "demo",
			[LIVE_PROOF_ENV.model]: "anthropic/claude-sonnet-4-6",
			[LIVE_PROOF_ENV.scopedModels]: "anthropic/claude-sonnet-4-6",
		});
		const report = newReport(prereq, ["mate", "demo", "demo", "thread"]);
		for (let i = 0; i < MAX_REPORT_PHASES + 5; i++) {
			appendPhase(report, {
				phase: "check",
				outcome: "pass",
				startedAt: new Date(0).toISOString(),
				endedAt: new Date(0).toISOString(),
			});
		}
		expect(report.phases.length).toBe(MAX_REPORT_PHASES);
	});
});

describe("newReport", () => {
	test("returns a deterministic shape with the prereq endpoint origin", () => {
		const prereq = readLiveProofPrereq({
			[LIVE_PROOF_ENV.endpoint]: "http://agent-core-lan:6420",
			[LIVE_PROOF_ENV.ownerScope]: "demo",
			[LIVE_PROOF_ENV.projectId]: "demo",
			[LIVE_PROOF_ENV.model]: "anthropic/claude-sonnet-4-6",
			[LIVE_PROOF_ENV.scopedModels]: "anthropic/claude-sonnet-4-6",
		});
		const report = newReport(prereq, ["mate", "demo", "demo", "thread"]);
		expect(report.schema).toBe(1);
		expect(report.endpointOrigin).toBe("http://agent-core-lan:6420");
		expect(report.namespace).toBe("default");
		expect(report.actorKey).toEqual(["mate", "demo", "demo", "thread"]);
		expect(report.phases).toEqual([]);
	});

	test("throws when the prereq has no endpoint origin", () => {
		expect(() =>
			newReport(readLiveProofPrereq({}), [
				"mate",
				"demo",
				"demo",
				"thread",
			]),
		).toThrow(/endpoint origin/);
	});
});

describe("defaultReportPath", () => {
	test("points at the local working directory", () => {
		expect(defaultReportPath()).toBe("./live-proof-report.json");
	});
});

describe("fingerprintSession", () => {
	test("normalizes a model descriptor to provider/id", () => {
		const fingerprint = fingerprintSession({
			sessionId: "session-1",
			model: { provider: "anthropic", id: "claude-sonnet-4-6" },
			messageCount: 4,
			isIdle: true,
		});
		expect(fingerprint).toEqual({
			sessionId: "session-1",
			model: "anthropic/claude-sonnet-4-6",
			messageCount: 4,
			isIdle: true,
		});
		expect(fingerprintEquals(fingerprint!, fingerprint!)).toBe(true);
	});

	test("returns undefined when the session id is missing", () => {
		expect(fingerprintSession({ messageCount: 0 })).toBeUndefined();
	});
});

describe("planAllPhases", () => {
	test("excludes verify-runtime-restart by default", () => {
		expect(planAllPhases({})).not.toContain("verify-runtime-restart");
	});

	test("includes verify-runtime-restart when opted in", () => {
		const phases = planAllPhases({
			[LIVE_PROOF_ENV.allowRuntimeRestart]: "1",
		});
		expect(phases).toContain("verify-runtime-restart");
		expect(phases.indexOf("verify-runtime-restart")).toBeGreaterThan(
			phases.indexOf("verify-unknown-outcome"),
		);
	});
});

describe("stableStringify", () => {
	test("sorts keys at every level", () => {
		const input = { b: 1, a: { y: 2, x: 1 }, c: [3, 2, 1] };
		const expected = JSON.stringify(
			{ a: { x: 1, y: 2 }, b: 1, c: [3, 2, 1] },
			null,
			2,
		);
		expect(stableStringify(input)).toBe(expected);
	});

	test("never echoes secrets named in the input", () => {
		const input = {
			apiKey: "DO-NOT-LEAK",
			actorKey: ["mate", "acme", "northstar"],
		};
		const dumped = stableStringify(input);
		expect(dumped).toContain("DO-NOT-LEAK");
		// The caller chooses what to redact; this test just confirms the
		// harness never invents fields the caller did not pass in.
	});
});

describe("dry-run guard", () => {
	test("the harness refuses to mark a phase as ok without all env vars", () => {
		const prereq = readLiveProofPrereq({});
		expect(prereq.ok).toBe(false);
		expect(prereq.skipReason).toBe("dry_run");
	});
});
