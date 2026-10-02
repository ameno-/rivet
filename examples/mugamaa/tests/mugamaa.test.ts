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
		if (this.unavailable.has(route.model))
			throw new ModelCapacityError(`${route.model} exhausted`);
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

	it("falls back to MiniMax M3 after frontier capacity exhaustion", async () => {
		const offices = new FixedOffices(
			pass,
			new Set([
				"gpt-5.6-sol",
				"claude-opus-4.8",
				"deepseek-v4.1-flash",
				"glm-5.3-flash",
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
				record.route?.model === "minimax-m3",
		);
		expect(fallbackSuccesses).toHaveLength(2);
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
});
