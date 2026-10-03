import { isModelCapacityError } from "./model-policy.ts";
import type { RecordsOffice } from "./records.ts";
import type {
	AuditInput,
	AuditVerdict,
	CaseState,
	CaseStatus,
	ModelPolicy,
	ModelRoute,
	OfficeRole,
	OfficeRunner,
	PlanningInput,
	ProductArtifact,
	WorkOrder,
	WorksInput,
} from "./types.ts";

/**
 * Idempotent case initialization.
 *
 * The Mugamaa seed appends a single `case.started` record once per case.
 * The actor workflow calls this from its initialization step; subsequent
 * replays of the same step must not append the record again.
 */
export function initializeCase(state: CaseState, records: RecordsOffice): void {
	if (state.records.some((record) => record.type === "case.started")) return;
	records.append("product", "case.started", { charter: state.charter });
}

/**
 * Planning phase.
 *
 * Drives `runner.plan` through the planning routes with capacity-only
 * fallback. Records the resulting `WorkOrder` on the case state and
 * advances `status` to `working` so the next phase can read a present
 * work order. Records the planning output before the phase returns so
 * the Works phase can rely on `state.workOrder` from actor state.
 */
export async function runPlanningPhase(
	state: CaseState,
	records: RecordsOffice,
	runner: OfficeRunner,
	policy: ModelPolicy,
): Promise<void> {
	state.status = "planning";
	const planningInput: PlanningInput = {
		charter: state.charter,
		iteration: state.iteration,
		previousArtifact: state.artifact,
		previousVerdicts: state.verdicts,
	};
	const workOrder = await runWithFallback(
		"planning",
		policy.planning,
		(route) => runner.plan(planningInput, route),
		records,
	);
	state.workOrder = workOrder;
	records.append("product", "work-order.issued", workOrder, {
		role: "planning",
	});
	state.status = "working";
}

/**
 * Works phase.
 *
 * Requires a `WorkOrder` already present on the case state from the
 * Planning phase. Drives `runner.work` through the works routes with
 * capacity-only fallback. Records the resulting `ProductArtifact` on
 * the case state and advances `status` to `auditing`.
 */
export async function runWorksPhase(
	state: CaseState,
	records: RecordsOffice,
	runner: OfficeRunner,
	policy: ModelPolicy,
): Promise<void> {
	if (state.workOrder === undefined) {
		throw new Error(
			"Works phase requires a Work Order produced by the Planning phase",
		);
	}
	state.status = "working";
	const worksInput: WorksInput = {
		charter: state.charter,
		iteration: state.iteration,
		previousArtifact: state.artifact,
		previousVerdicts: state.verdicts,
		workOrder: state.workOrder,
	};
	const artifact = await runWithFallback(
		"works",
		policy.works,
		(route) => runner.work(worksInput, route),
		records,
	);
	state.artifact = artifact;
	records.append("product", "artifact.produced", artifact, {
		role: "works",
	});
	state.status = "auditing";
}

/**
 * Audit phase.
 *
 * Requires both a `WorkOrder` and a `ProductArtifact` already present
 * on the case state from the preceding phases. Drives `runner.audit`
 * with the same parallel-routes-then-fallback semantics the seed used.
 * Records the verdicts on the case state but leaves the terminal
 * `status` to the Decision phase.
 */
export async function runAuditPhase(
	state: CaseState,
	records: RecordsOffice,
	runner: OfficeRunner,
	policy: ModelPolicy,
): Promise<void> {
	if (state.workOrder === undefined) {
		throw new Error(
			"Audit phase requires a Work Order produced by the Planning phase",
		);
	}
	if (state.artifact === undefined) {
		throw new Error(
			"Audit phase requires an Artifact produced by the Works phase",
		);
	}
	state.status = "auditing";
	const auditInput: AuditInput = {
		charter: state.charter,
		iteration: state.iteration,
		workOrder: state.workOrder,
		artifact: state.artifact,
	};
	const verdicts = await runAuditAtScale(auditInput, policy, runner, records);
	state.verdicts = verdicts;
	records.append(
		"product",
		"audit.completed",
		{ verdicts },
		{
			role: "audit",
		},
	);
}

export type DecisionOutcome =
	| { kind: "complete" }
	| { kind: "blocked" }
	| { kind: "revise" };

export interface DecisionPhaseResult {
	outcome: DecisionOutcome;
	status: CaseStatus;
}

/**
 * Decision phase.
 *
 * Inspects the most recent verdicts and decides what the case should
 * do next: complete, block, or request a revision. Records the
 * terminal / revision marker on the case state before returning so the
 * actor workflow can branch deterministically.
 *
 * Exhaustion of the iteration budget is decided by the loop itself
 * (after `decidePhaseOutcome` returns `revise` on the final iteration);
 * the model phase helpers intentionally do not surface exhaustion so
 * the decision step stays a pure function of the verdicts.
 */
export function decidePhaseOutcome(
	state: CaseState,
	records: RecordsOffice,
): DecisionPhaseResult {
	if (state.verdicts.some((verdict) => verdict.decision === "blocked")) {
		state.status = "blocked";
		records.append("product", "case.blocked", { verdicts: state.verdicts });
		return { outcome: { kind: "blocked" }, status: "blocked" };
	}
	if (state.verdicts.every((verdict) => verdict.decision === "pass")) {
		state.status = "completed";
		records.append("product", "case.completed", {
			artifact: state.artifact,
		});
		return { outcome: { kind: "complete" }, status: "completed" };
	}
	state.status = "revising";
	records.append("product", "case.revision-requested", {
		verdicts: state.verdicts,
	});
	return { outcome: { kind: "revise" }, status: "revising" };
}

/**
 * Records the case-exhausted terminal marker and advances status.
 *
 * Called once the iteration budget is spent without reaching a
 * complete or blocked decision. Exposed as its own helper so the
 * actor workflow can record exhaustion as the final deterministic
 * record on the loop's exit branch.
 */
export function recordCaseExhausted(
	state: CaseState,
	records: RecordsOffice,
): void {
	state.status = "exhausted";
	records.append("product", "case.exhausted", {
		maxIterations: state.charter.maxIterations,
	});
}

async function runWithFallback<T>(
	role: OfficeRole,
	routes: readonly ModelRoute[],
	run: (route: ModelRoute) => Promise<T>,
	records: RecordsOffice,
): Promise<T> {
	for (const route of routes) {
		try {
			const output = await run(route);
			records.append("process", "model.succeeded", {}, { role, route });
			return output;
		} catch (error) {
			if (!isModelCapacityError(error)) throw error;
			records.append(
				"process",
				"model.capacity-exhausted",
				{ message: error.message },
				{ role, route },
			);
		}
	}
	throw new Error(`No model route remained for ${role}`);
}

async function runAuditAtScale(
	input: AuditInput,
	policy: ModelPolicy,
	runner: OfficeRunner,
	records: RecordsOffice,
): Promise<AuditVerdict[]> {
	const attempts = await Promise.all(
		policy.audit.primary.map(async (route) => {
			try {
				const verdict = await runner.audit(input, route);
				records.append(
					"process",
					"model.succeeded",
					{},
					{ role: "audit", route },
				);
				return verdict;
			} catch (error) {
				if (!isModelCapacityError(error)) throw error;
				records.append(
					"process",
					"model.capacity-exhausted",
					{ message: error.message },
					{
						role: "audit",
						route,
					},
				);
				return undefined;
			}
		}),
	);
	const verdicts = attempts.filter(
		(verdict): verdict is AuditVerdict => verdict !== undefined,
	);
	if (verdicts.length > 0) return verdicts;
	return [
		await runWithFallback(
			"audit",
			policy.audit.fallback,
			(route) => runner.audit(input, route),
			records,
		),
	];
}
