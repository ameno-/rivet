export type ThinkingLevel = "low" | "medium";
export type OfficeRole = "planning" | "works" | "audit";
export type ModelTier = "open" | "frontier" | "fallback";

export interface ModelRoute {
	provider: "opencode" | "codex" | "copilot" | "litellm";
	model: string;
	thinking: ThinkingLevel;
	tier: ModelTier;
}

export interface ModelPolicy {
	planning: readonly ModelRoute[];
	works: readonly ModelRoute[];
	audit: {
		primary: readonly ModelRoute[];
		fallback: readonly ModelRoute[];
	};
}

export interface GoalCharter {
	id: string;
	title: string;
	objective: string;
	acceptanceCriteria: string[];
	constraints: string[];
	maxIterations: number;
}

export interface WorkOrder {
	summary: string;
	tasks: string[];
	successConditions: string[];
}

export interface ProductArtifact {
	summary: string;
	body: string;
	evidence: string[];
}

export interface AuditVerdict {
	decision: "pass" | "revise" | "blocked";
	rationale: string;
	findings: string[];
}

export type RecordCategory = "product" | "process";

export interface MugamaaRecord {
	seq: number;
	at: number;
	caseId: string;
	iteration: number;
	category: RecordCategory;
	type: string;
	role?: OfficeRole;
	route?: ModelRoute;
	payload: unknown;
}

export type CaseStatus =
	| "pending"
	| "planning"
	| "working"
	| "auditing"
	| "revising"
	| "completed"
	| "blocked"
	| "exhausted";

export interface CaseState {
	charter: GoalCharter;
	status: CaseStatus;
	iteration: number;
	workOrder?: WorkOrder;
	artifact?: ProductArtifact;
	verdicts: AuditVerdict[];
	records: MugamaaRecord[];
}

export interface PlanningInput {
	charter: GoalCharter;
	iteration: number;
	previousArtifact?: ProductArtifact;
	previousVerdicts: AuditVerdict[];
}

export interface WorksInput extends PlanningInput {
	workOrder: WorkOrder;
}

export interface AuditInput {
	charter: GoalCharter;
	iteration: number;
	workOrder: WorkOrder;
	artifact: ProductArtifact;
}

export interface OfficeRunner {
	plan(input: PlanningInput, route: ModelRoute): Promise<WorkOrder>;
	work(input: WorksInput, route: ModelRoute): Promise<ProductArtifact>;
	audit(input: AuditInput, route: ModelRoute): Promise<AuditVerdict>;
}
