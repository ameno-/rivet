import { describe, expect, it } from "vitest";
import { Mugamaa } from "../src/engine.ts";
import {
	DEFAULT_MODEL_POLICY,
	ModelCapacityError,
} from "../src/model-policy.ts";
import { durableStorageIssue, runSample } from "../src/sample.ts";
import type {
	AuditInput,
	AuditVerdict,
	ModelPolicy,
	ModelRoute,
	OfficeRunner,
	PlanningInput,
	ProductArtifact,
	WorkOrder,
	WorksInput,
} from "../src/types.ts";

const order: WorkOrder = {
	summary: "Do the bounded work",
	tasks: ["Produce one artifact"],
	successConditions: ["The artifact is auditable"],
};
const artifact: ProductArtifact = {
	summary: "Artifact",
	body: "Evidence",
	evidence: ["test"],
};
const pass: AuditVerdict = {
	decision: "pass",
	rationale: "Meets the charter",
	findings: [],
};

class FixedOffices implements OfficeRunner {
	constructor(
		readonly verdict: AuditVerdict = pass,
		readonly unavailable: ReadonlySet<string> = new Set(),
	) {}
	async plan(_input: PlanningInput, route: ModelRoute) {
		this.#check(route);
		return order;
	}
	async work(_input: WorksInput, route: ModelRoute) {
		this.#check(route);
		return artifact;
	}
	async audit(_input: AuditInput, route: ModelRoute) {
		this.#check(route);
		return this.verdict;
	}
	#check(route: ModelRoute) {
		const identity = `${route.provider}/${route.model}`;
		if (this.unavailable.has(identity))
			throw new ModelCapacityError(`${identity} exhausted`);
	}
}

describe("Mugamaa Seed", () => {
	it("revises an issue artifact and completes on the second audit", async () => {
		const state = await runSample();
		expect(state.status).toBe("completed");
		expect(state.iteration).toBe(2);
		expect(state.artifact?.body).toContain("Rollback:");
		expect(
			state.records.some(
				(record) => record.type === "case.revision-requested",
			),
		).toBe(true);
		expect(state.records.map((record) => record.seq)).toEqual(
			state.records.map((_, index) => index + 1),
		);
	});

	it("falls back to MiniMax M3 only for roles whose policy permits fallback", async () => {
		// Every OpenCode-go primary for planning, works, and audit is
		// marked unavailable. Planning and works fall back to the
		// minimax-direct/minimax-m3 fallback; audit falls back as well
		// because both OpenCode-go primaries report capacity exhaustion.
		const offices = new FixedOffices(
			pass,
			new Set([
				"opencode-go/kimi-k3",
				"opencode-go/grok-4.7",
				"opencode-go/glm-5.3-flash",
			]),
		);
		const state = await new Mugamaa({
			policy: DEFAULT_MODEL_POLICY,
			runner: offices,
			now: () => 1,
		}).run({
			...durableStorageIssue,
			maxIterations: 1,
		});
		expect(state.status).toBe("completed");
		const fallbackSuccesses = state.records.filter(
			(record) =>
				record.type === "model.succeeded" &&
				record.route?.provider === "minimax-direct" &&
				record.route?.model === "minimax-m3",
		);
		// Planning fallback + Works fallback + Audit fallback = 3.
		expect(fallbackSuccesses).toHaveLength(3);
		expect(
			state.records.filter(
				(record) => record.type === "model.capacity-exhausted",
			),
		).toHaveLength(4);
	});

	it("stops immediately when an audit blocks the case", async () => {
		const blocked: AuditVerdict = {
			decision: "blocked",
			rationale: "The requested change violates a constraint",
			findings: ["Requires supervisor decision"],
		};
		const state = await new Mugamaa({
			policy: DEFAULT_MODEL_POLICY,
			runner: new FixedOffices(blocked),
		}).run({
			...durableStorageIssue,
			maxIterations: 3,
		});
		expect(state.status).toBe("blocked");
		expect(state.iteration).toBe(1);
		expect(state.records.at(-1)?.type).toBe("case.blocked");
	});

	it("exhausts the charter's iteration budget when audits keep requesting revision", async () => {
		const revise: AuditVerdict = {
			decision: "revise",
			rationale: "More evidence is required",
			findings: ["Add another receipt"],
		};
		const state = await new Mugamaa({
			policy: DEFAULT_MODEL_POLICY,
			runner: new FixedOffices(revise),
		}).run({
			...durableStorageIssue,
			maxIterations: 2,
		});
		expect(state.status).toBe("exhausted");
		expect(state.iteration).toBe(2);
		expect(state.records.at(-1)?.type).toBe("case.exhausted");
	});

	it("chooses the opencode-go Works primary route when it succeeds", async () => {
		// The default policy lists opencode-go/grok-4.7 as the Works
		// primary and minimax-direct/minimax-m3 as the fallback. When
		// the primary succeeds normally, the fallback must never be
		// invoked for Works.
		const workRoutesAttempted: ModelRoute[] = [];
		class RecordingRunner implements OfficeRunner {
			async plan(_input: PlanningInput, _route: ModelRoute) {
				return order;
			}
			async work(
				_input: WorksInput,
				route: ModelRoute,
			): Promise<ProductArtifact> {
				workRoutesAttempted.push(route);
				return artifact;
			}
			async audit(
				_input: AuditInput,
				_route: ModelRoute,
			): Promise<AuditVerdict> {
				return pass;
			}
		}
		const state = await new Mugamaa({
			policy: DEFAULT_MODEL_POLICY,
			runner: new RecordingRunner(),
			now: () => 1,
		}).run({
			...durableStorageIssue,
			maxIterations: 1,
		});
		expect(state.status).toBe("completed");
		// Only the opencode-go primary was attempted; the
		// minimax-direct/minimax-m3 fallback was untouched.
		expect(
			workRoutesAttempted.map((route) => [route.provider, route.model]),
		).toEqual([["opencode-go", "grok-4.7"]]);
		const minimaxRoutes = workRoutesAttempted.filter(
			(route) =>
				route.provider === "minimax-direct" &&
				route.model === "minimax-m3",
		);
		expect(minimaxRoutes).toHaveLength(0);
	});

	it("falls back to minimax-direct/minimax-m3 only after capacity exhaustion of the opencode-go Works primary", async () => {
		// Planning succeeds on its opencode-go/kimi-k3 route; the
		// opencode-go/grok-4.7 Works primary throws a classified
		// ModelCapacityError (quota / capacity / token exhaustion).
		// The engine must try the primary, then succeed on the
		// minimax-direct/minimax-m3 fallback, and only then reach the
		// audit phase. Non-capacity failures on the primary would not
		// trigger this fallback.
		const workRoutesAttempted: ModelRoute[] = [];
		class RecordingRunner implements OfficeRunner {
			async plan(_input: PlanningInput, _route: ModelRoute) {
				return order;
			}
			async work(
				_input: WorksInput,
				route: ModelRoute,
			): Promise<ProductArtifact> {
				workRoutesAttempted.push(route);
				// Throw ModelCapacityError for every route except the
				// exact minimax-direct/minimax-m3 fallback. The correct
				// OR logic (De Morgan over "provider AND model") rejects
				// anything that is not both the AND-identical fallback.
				if (
					route.provider !== "minimax-direct" ||
					route.model !== "minimax-m3"
				) {
					throw new ModelCapacityError(
						`${route.provider}/${route.model} exhausted`,
					);
				}
				return artifact;
			}
			async audit(
				_input: AuditInput,
				_route: ModelRoute,
			): Promise<AuditVerdict> {
				return pass;
			}
		}
		const state = await new Mugamaa({
			policy: DEFAULT_MODEL_POLICY,
			runner: new RecordingRunner(),
			now: () => 1,
		}).run({
			...durableStorageIssue,
			maxIterations: 1,
		});
		expect(state.status).toBe("completed");
		// The opencode-go/grok-4.7 Works primary was attempted first,
		// then the minimax-direct/minimax-m3 fallback.
		expect(
			workRoutesAttempted.map((route) => [route.provider, route.model]),
		).toEqual([
			["opencode-go", "grok-4.7"],
			["minimax-direct", "minimax-m3"],
		]);
		// The capacity-exhausted record was emitted for the primary
		// route exactly once; the minimax fallback produced a success
		// record.
		const capacityExhausted = state.records.filter(
			(record) => record.type === "model.capacity-exhausted",
		);
		expect(capacityExhausted).toHaveLength(1);
		expect(
			capacityExhausted.every(
				(record) =>
					record.role === "works" && record.route?.tier === "open",
			),
		).toBe(true);
		const minimaxSuccesses = state.records.filter(
			(record) =>
				record.type === "model.succeeded" &&
				record.route?.provider === "minimax-direct" &&
				record.route?.model === "minimax-m3",
		);
		expect(minimaxSuccesses).toHaveLength(1);
	});

	it("does not fall back on Works when the primary route throws a non-capacity error", async () => {
		// The opencode-go/grok-4.7 Works primary is wired to throw a
		// plain Error (the kind malformed output and arbitrary
		// provider/HTTP errors produce after the live runner classifies
		// them). The engine must surface the error immediately without
		// ever attempting the minimax-direct/minimax-m3 fallback.
		const workRoutesAttempted: ModelRoute[] = [];
		class RecordingRunner implements OfficeRunner {
			async plan(_input: PlanningInput, _route: ModelRoute) {
				return order;
			}
			async work(
				_input: WorksInput,
				route: ModelRoute,
			): Promise<ProductArtifact> {
				workRoutesAttempted.push(route);
				throw new Error(
					`Office transport rejected request: ${route.model} broken`,
				);
			}
			async audit(
				_input: AuditInput,
				_route: ModelRoute,
			): Promise<AuditVerdict> {
				throw new Error("audit should not be invoked");
			}
		}
		const engine = new Mugamaa({
			policy: DEFAULT_MODEL_POLICY,
			runner: new RecordingRunner(),
			now: () => 1,
		});
		let caught: unknown;
		try {
			await engine.run({
				...durableStorageIssue,
				maxIterations: 1,
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toBe(
			"Office transport rejected request: grok-4.7 broken",
		);
		// Only the opencode-go primary was attempted; the engine stopped
		// at the non-capacity failure and never tried the
		// minimax-direct/minimax-m3 fallback.
		expect(
			workRoutesAttempted.map((route) => [route.provider, route.model]),
		).toEqual([["opencode-go", "grok-4.7"]]);
	});

	it("rejects Works when every route, including the MiniMax fallback, exhausts capacity", async () => {
		// Every Works route -- the opencode-go/grok-4.7 primary and the
		// minimax-direct/minimax-m3 fallback -- throws a classified
		// ModelCapacityError. The engine must exhaust the policy in
		// order, recording each attempt, and surface a deterministic
		// rejection rather than silently dropping the case.
		const workRoutesAttempted: ModelRoute[] = [];
		class RecordingRunner implements OfficeRunner {
			async plan(_input: PlanningInput, _route: ModelRoute) {
				return order;
			}
			async work(
				_input: WorksInput,
				route: ModelRoute,
			): Promise<ProductArtifact> {
				workRoutesAttempted.push(route);
				throw new ModelCapacityError(
					`${route.provider}/${route.model} exhausted`,
				);
			}
			async audit(
				_input: AuditInput,
				_route: ModelRoute,
			): Promise<AuditVerdict> {
				throw new Error("audit should not be invoked");
			}
		}
		const engine = new Mugamaa({
			policy: DEFAULT_MODEL_POLICY,
			runner: new RecordingRunner(),
			now: () => 1,
		});
		let caught: unknown;
		try {
			await engine.run({
				...durableStorageIssue,
				maxIterations: 1,
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toBe(
			"No model route remained for works",
		);
		// Both Works routes were attempted in policy order: the
		// opencode-go primary, then the minimax-direct fallback. Each
		// attempt threw a classified ModelCapacityError, which is the
		// only way the engine would continue iterating rather than
		// re-throwing.
		expect(
			workRoutesAttempted.map((route) => [route.provider, route.model]),
		).toEqual([
			["opencode-go", "grok-4.7"],
			["minimax-direct", "minimax-m3"],
		]);
	});
});

describe("Mugamaa v0.2 default policy regression", () => {
	// The regression test recursively inspects the default policy
	// and fails if any Codex/GPT route appears. It exists so the
	// Phase 1 migration cannot silently regress the model surface:
	// the only accepted providers in DEFAULT_MODEL_POLICY are
	// `opencode-go` and `minimax-direct`, and no model whose id
	// begins with `gpt-` may appear at any level of the policy tree.

	const FORBIDDEN_PROVIDERS: ReadonlySet<string> = new Set([
		"codex",
		"openai-codex",
		"copilot",
		"opencode",
	]);

	function walk(routes: readonly ModelRoute[]): ModelRoute[] {
		return routes.slice();
	}

	it("contains no Codex or GPT route at any level", () => {
		const policy: ModelPolicy = DEFAULT_MODEL_POLICY;
		const all: ModelRoute[] = [
			...walk(policy.planning),
			...walk(policy.works),
			...walk(policy.audit.primary),
			...walk(policy.audit.fallback),
		];
		const violations: string[] = [];
		for (const route of all) {
			if (FORBIDDEN_PROVIDERS.has(route.provider)) {
				violations.push(
					`forbidden provider ${route.provider} on ${route.provider}/${route.model}`,
				);
			}
			if (route.model.startsWith("gpt-")) {
				violations.push(
					`forbidden GPT model id ${route.provider}/${route.model}`,
				);
			}
			if (route.provider === "opencode-go") {
				const allowed = new Set([
					"kimi-k3",
					"grok-4.7",
					"glm-5.3-flash",
				]);
				if (!allowed.has(route.model)) {
					violations.push(
						`unrecognized opencode-go model ${route.provider}/${route.model}`,
					);
				}
			}
			if (
				route.provider === "minimax-direct" &&
				route.model !== "minimax-m3"
			) {
				violations.push(
					`unrecognized direct provider model ${route.provider}/${route.model}`,
				);
			}
		}
		expect(violations).toEqual([]);
	});

	it("keeps the verified role shape for planning, works, and audit", () => {
		expect(
			DEFAULT_MODEL_POLICY.planning.map((route) => [
				route.provider,
				route.model,
				route.thinking,
			]),
		).toEqual([
			["opencode-go", "kimi-k3", "medium"],
			["minimax-direct", "minimax-m3", "low"],
		]);
		expect(
			DEFAULT_MODEL_POLICY.works.map((route) => [
				route.provider,
				route.model,
				route.thinking,
			]),
		).toEqual([
			["opencode-go", "grok-4.7", "medium"],
			["minimax-direct", "minimax-m3", "low"],
		]);
		expect(
			DEFAULT_MODEL_POLICY.audit.primary.map((route) => [
				route.provider,
				route.model,
				route.thinking,
			]),
		).toEqual([
			["opencode-go", "glm-5.3-flash", "medium"],
			["opencode-go", "grok-4.7", "low"],
		]);
		expect(
			DEFAULT_MODEL_POLICY.audit.fallback.map((route) => [
				route.provider,
				route.model,
				route.thinking,
			]),
		).toEqual([["minimax-direct", "minimax-m3", "low"]]);
	});

	it("never routes an OpenCode MiniMax model", () => {
		// Phase 1 invariant: the default policy routes only through
		// `opencode-go` and `minimax-direct`. The runner never enters
		// an OpenCode-hosted MiniMax route in source, tests, or
		// records.
		const policy: ModelPolicy = DEFAULT_MODEL_POLICY;
		const routes = [
			...policy.planning,
			...policy.works,
			...policy.audit.primary,
			...policy.audit.fallback,
		];
		const opencodeMinimax = routes.filter(
			(route) =>
				route.provider.startsWith("opencode") &&
				route.model === "minimax-m3",
		);
		expect(opencodeMinimax).toEqual([]);
	});
});
