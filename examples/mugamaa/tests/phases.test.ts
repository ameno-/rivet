import { describe, expect, it } from "vitest";
import { createCaseState, Mugamaa } from "../src/engine.ts";
import { DEFAULT_MODEL_POLICY } from "../src/model-policy.ts";
import {
	decidePhaseOutcome,
	initializeCase,
	recordCaseExhausted,
	runAuditPhase,
	runPlanningPhase,
	runWorksPhase,
} from "../src/phases.ts";
import { RecordsOffice } from "../src/records.ts";
import {
	artifact,
	blocked,
	charter,
	order,
	PhaseRunner,
	pass,
	phaseState,
	revise,
} from "./phases.fakes.ts";

const recordTypes = (records: { type: string }[]) =>
	records.map((record) => record.type);

describe("Mugamaa phase helpers", () => {
	it("initializes a case exactly once", () => {
		const { state, records } = phaseState();
		initializeCase(state, records);
		initializeCase(state, records);
		expect(recordTypes(state.records)).toEqual(["case.started"]);
	});

	it("plans and advances to working without producing an artifact", async () => {
		const { state, records } = phaseState();
		const runner = new PhaseRunner();
		await runPlanningPhase(state, records, runner, DEFAULT_MODEL_POLICY);
		expect(state.status).toBe("working");
		expect(state.workOrder).toEqual(order);
		expect(state.artifact).toBeUndefined();
		expect(recordTypes(state.records)).toEqual([
			"model.succeeded",
			"work-order.issued",
		]);
	});

	it("requires a Work Order before Works", async () => {
		const { state, records } = phaseState();
		await expect(
			runWorksPhase(
				state,
				records,
				new PhaseRunner(),
				DEFAULT_MODEL_POLICY,
			),
		).rejects.toThrow(/requires a Work Order/);
	});

	it("works records an artifact and advances to auditing", async () => {
		const { state, records } = phaseState();
		state.workOrder = order;
		await runWorksPhase(
			state,
			records,
			new PhaseRunner(),
			DEFAULT_MODEL_POLICY,
		);
		expect(state.status).toBe("auditing");
		expect(state.artifact).toEqual(artifact);
		expect(recordTypes(state.records)).toEqual([
			"model.succeeded",
			"artifact.produced",
		]);
	});

	it("requires both Work Order and Artifact before Audit", async () => {
		const first = phaseState();
		await expect(
			runAuditPhase(
				first.state,
				first.records,
				new PhaseRunner(),
				DEFAULT_MODEL_POLICY,
			),
		).rejects.toThrow(/requires a Work Order/);

		const second = phaseState();
		second.state.workOrder = order;
		await expect(
			runAuditPhase(
				second.state,
				second.records,
				new PhaseRunner(),
				DEFAULT_MODEL_POLICY,
			),
		).rejects.toThrow(/requires an Artifact/);
	});

	it("audits all primary routes and leaves the decision separate", async () => {
		const { state, records } = phaseState();
		state.workOrder = order;
		state.artifact = artifact;
		const runner = new PhaseRunner();
		await runAuditPhase(state, records, runner, DEFAULT_MODEL_POLICY);
		expect(state.status).toBe("auditing");
		expect(state.verdicts).toEqual([pass, pass]);
		expect(runner.auditCalls).toBe(2);
		expect(recordTypes(state.records)).toEqual([
			"model.succeeded",
			"model.succeeded",
			"audit.completed",
		]);
	});

	it.each([
		[pass, "completed", "case.completed", "complete"],
		[blocked, "blocked", "case.blocked", "blocked"],
		[revise, "revising", "case.revision-requested", "revise"],
	] as const)("decides %s verdicts deterministically", (verdict, status, recordType, outcome) => {
		const { state, records } = phaseState();
		state.artifact = artifact;
		state.verdicts = [verdict];
		const result = decidePhaseOutcome(state, records);
		expect(state.status).toBe(status);
		expect(result.outcome.kind).toBe(outcome);
		expect(state.records.at(-1)?.type).toBe(recordType);
	});

	it("records terminal exhaustion after the final revision", () => {
		const { state, records } = phaseState();
		state.verdicts = [revise];
		decidePhaseOutcome(state, records);
		recordCaseExhausted(state, records);
		expect(state.status).toBe("exhausted");
		expect(recordTypes(state.records)).toEqual([
			"case.revision-requested",
			"case.exhausted",
		]);
	});

	it("matches Mugamaa.run state and record ordering", async () => {
		const directRunner = new PhaseRunner();
		const direct = await new Mugamaa({
			policy: DEFAULT_MODEL_POLICY,
			runner: directRunner,
			now: () => 1,
		}).run({ ...charter, maxIterations: 1 });

		const state = createCaseState({ ...charter, maxIterations: 1 });
		const records = new RecordsOffice(state, () => 1);
		const phaseRunner = new PhaseRunner();
		initializeCase(state, records);
		state.iteration = 1;
		await runPlanningPhase(
			state,
			records,
			phaseRunner,
			DEFAULT_MODEL_POLICY,
		);
		await runWorksPhase(state, records, phaseRunner, DEFAULT_MODEL_POLICY);
		await runAuditPhase(state, records, phaseRunner, DEFAULT_MODEL_POLICY);
		decidePhaseOutcome(state, records);

		expect(state).toEqual(direct);
		expect(recordTypes(state.records)).toEqual(recordTypes(direct.records));
	});

	it("attempts a planning error once and records no output", async () => {
		const { state, records } = phaseState();
		const runner = new PhaseRunner();
		runner.planError = new Error("indeterminate planning failure");
		await expect(
			runPlanningPhase(state, records, runner, DEFAULT_MODEL_POLICY),
		).rejects.toThrow("indeterminate planning failure");
		expect(runner.planCalls).toBe(1);
		expect(state.workOrder).toBeUndefined();
		expect(state.records).toEqual([]);
	});
});
