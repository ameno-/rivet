import { createCaseState } from "../src/engine.ts";
import { RecordsOffice } from "../src/records.ts";
import type {
	AuditInput,
	AuditVerdict,
	CaseState,
	GoalCharter,
	ModelRoute,
	OfficeRunner,
	PlanningInput,
	ProductArtifact,
	WorkOrder,
	WorksInput,
} from "../src/types.ts";

export const charter: GoalCharter = {
	id: "phase-test",
	title: "Phase test",
	objective: "Prove each Mugamaa phase independently",
	acceptanceCriteria: ["Every phase emits an ordered record"],
	constraints: [],
	maxIterations: 2,
};

export const order: WorkOrder = {
	summary: "Build the artifact",
	tasks: ["Produce evidence"],
	successConditions: charter.acceptanceCriteria,
};

export const artifact: ProductArtifact = {
	summary: "Artifact",
	body: "Evidence",
	evidence: ["phase receipt"],
};

export const pass: AuditVerdict = {
	decision: "pass",
	rationale: "The artifact meets the charter",
	findings: [],
};

export const revise: AuditVerdict = {
	decision: "revise",
	rationale: "Another iteration is required",
	findings: ["Add evidence"],
};

export const blocked: AuditVerdict = {
	decision: "blocked",
	rationale: "Supervisor input is required",
	findings: ["Resolve the policy conflict"],
};

export class PhaseRunner implements OfficeRunner {
	planCalls = 0;
	workCalls = 0;
	auditCalls = 0;
	planError?: Error;
	verdict: AuditVerdict = pass;

	async plan(_input: PlanningInput, _route: ModelRoute): Promise<WorkOrder> {
		this.planCalls += 1;
		if (this.planError) throw this.planError;
		return order;
	}

	async work(
		_input: WorksInput,
		_route: ModelRoute,
	): Promise<ProductArtifact> {
		this.workCalls += 1;
		return artifact;
	}

	async audit(_input: AuditInput, _route: ModelRoute): Promise<AuditVerdict> {
		this.auditCalls += 1;
		return this.verdict;
	}
}

export function phaseState(): {
	state: CaseState;
	records: RecordsOffice;
} {
	const state = createCaseState(charter);
	state.iteration = 1;
	return { state, records: new RecordsOffice(state, () => 1) };
}
