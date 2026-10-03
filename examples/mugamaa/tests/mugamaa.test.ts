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
		const offices = new FixedOffices(
			pass,
			new Set([
				"opencode/kimi-k3",
				"opencode/deepseek-v4.1-flash",
				"opencode/glm-5.3-flash",
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
		expect(fallbackSuccesses).toHaveLength(2);
		expect(
			state.records.filter(
				(record) => record.type === "model.capacity-exhausted",
			),
		).toHaveLength(3);
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

	it("chooses the frontier Works primary route when it succeeds", async () => {
		// The default policy lists two frontier Works routes and a
		// minimax-direct/minimax-m3 fallback. When the frontier routes
		// succeed normally, the fallback must never be invoked for Works.
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
		// Only the first frontier route was attempted; the second frontier
		// route and the minimax-direct/minimax-m3 fallback were untouched.
		expect(
			workRoutesAttempted.map((route) => [route.provider, route.model]),
		).toEqual([["codex", "gpt-5.6-sol"]]);
		const minimaxRoutes = workRoutesAttempted.filter(
			(route) =>
				route.provider === "minimax-direct" &&
				route.model === "minimax-m3",
		);
		expect(minimaxRoutes).toHaveLength(0);
	});

	it("falls back to minimax-direct/minimax-m3 only after capacity exhaustion of frontier Works routes", async () => {
		// Planning succeeds on its opencode/kimi-k3 route; both frontier
		// Works routes throw classified ModelCapacityError (quota /
		// capacity / token exhaustion). The engine must try them in policy
		// order, then succeed on the minimax-direct/minimax-m3 fallback,
		// and only then reach the audit phase. Non-capacity failures on the
		// frontier would not trigger this fallback.
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
		// The two frontier Works routes were attempted first in policy
		// order, then the minimax-direct/minimax-m3 fallback.
		expect(
			workRoutesAttempted.map((route) => [route.provider, route.model]),
		).toEqual([
			["codex", "gpt-5.6-sol"],
			["copilot", "claude-opus-4.8"],
			["minimax-direct", "minimax-m3"],
		]);
		// The capacity-exhausted record was emitted for each frontier route
		// exactly once; the minimax fallback produced a success record.
		const capacityExhausted = state.records.filter(
			(record) => record.type === "model.capacity-exhausted",
		);
		expect(capacityExhausted).toHaveLength(2);
		expect(
			capacityExhausted.every(
				(record) =>
					record.role === "works" &&
					record.route?.tier === "frontier",
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

	it("does not fall back on Works when the frontier route throws a non-capacity error", async () => {
		// The two frontier Works routes are wired to throw a plain Error
		// (the kind malformed output and arbitrary provider/HTTP errors
		// produce after the live runner classifies them). The engine must
		// surface the error immediately without ever attempting the
		// minimax-direct/minimax-m3 fallback.
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
			"Office transport rejected request: gpt-5.6-sol broken",
		);
		// Only the first frontier route was attempted; the engine stopped
		// at the non-capacity failure and never tried the second frontier
		// route nor the minimax-direct/minimax-m3 fallback.
		expect(
			workRoutesAttempted.map((route) => [route.provider, route.model]),
		).toEqual([["codex", "gpt-5.6-sol"]]);
	});

	it("rejects Works when every route, including the MiniMax fallback, exhausts capacity", async () => {
		// Every Works route -- both frontier routes and the
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
		// All three exact Works routes were attempted in policy order:
		// the two frontier routes, then the minimax-direct fallback. Each
		// attempt threw a classified ModelCapacityError, which is the only
		// way the engine would continue iterating rather than re-throwing.
		expect(
			workRoutesAttempted.map((route) => [route.provider, route.model]),
		).toEqual([
			["codex", "gpt-5.6-sol"],
			["copilot", "claude-opus-4.8"],
			["minimax-direct", "minimax-m3"],
		]);
	});
});
