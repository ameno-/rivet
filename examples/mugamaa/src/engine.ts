import { isModelCapacityError } from "./model-policy.ts";
import { RecordsOffice } from "./records.ts";
import type {
	AuditInput,
	AuditVerdict,
	CaseState,
	GoalCharter,
	ModelPolicy,
	ModelRoute,
	OfficeRole,
	OfficeRunner,
	PlanningInput,
	WorksInput,
} from "./types.ts";

export function createCaseState(charter: GoalCharter): CaseState {
	if (!charter.id.trim()) throw new Error("Goal Charter requires an id");
	if (!charter.objective.trim())
		throw new Error("Goal Charter requires an objective");
	if (charter.acceptanceCriteria.length === 0) {
		throw new Error("Goal Charter requires acceptance criteria");
	}
	if (!Number.isInteger(charter.maxIterations) || charter.maxIterations < 1) {
		throw new Error(
			"Goal Charter maxIterations must be a positive integer",
		);
	}
	return {
		charter: {
			...charter,
			acceptanceCriteria: [...charter.acceptanceCriteria],
			constraints: [...charter.constraints],
		},
		status: "pending",
		iteration: 0,
		verdicts: [],
		records: [],
	};
}

export interface MugamaaOptions {
	policy: ModelPolicy;
	runner: OfficeRunner;
	now?: () => number;
}

export class Mugamaa {
	readonly #policy: ModelPolicy;
	readonly #runner: OfficeRunner;
	readonly #now: () => number;

	constructor(options: MugamaaOptions) {
		this.#policy = options.policy;
		this.#runner = options.runner;
		this.#now = options.now ?? Date.now;
	}

	async run(charter: GoalCharter): Promise<CaseState> {
		const state = createCaseState(charter);
		const records = new RecordsOffice(state, this.#now);
		records.append("product", "case.started", { charter: state.charter });

		for (
			let iteration = 1;
			iteration <= charter.maxIterations;
			iteration++
		) {
			state.iteration = iteration;
			state.status = "planning";
			const planningInput: PlanningInput = {
				charter,
				iteration,
				previousArtifact: state.artifact,
				previousVerdicts: state.verdicts,
			};
			const workOrder = await this.#withFallback(
				"planning",
				this.#policy.planning,
				(route) => this.#runner.plan(planningInput, route),
				records,
			);
			state.workOrder = workOrder;
			records.append("product", "work-order.issued", workOrder, {
				role: "planning",
			});

			state.status = "working";
			const worksInput: WorksInput = { ...planningInput, workOrder };
			const artifact = await this.#withFallback(
				"works",
				this.#policy.works,
				(route) => this.#runner.work(worksInput, route),
				records,
			);
			state.artifact = artifact;
			records.append("product", "artifact.produced", artifact, {
				role: "works",
			});

			state.status = "auditing";
			const auditInput: AuditInput = {
				charter,
				iteration,
				workOrder,
				artifact,
			};
			const verdicts = await this.#auditAtScale(auditInput, records);
			state.verdicts = verdicts;
			records.append(
				"product",
				"audit.completed",
				{ verdicts },
				{ role: "audit" },
			);

			if (verdicts.some((verdict) => verdict.decision === "blocked")) {
				state.status = "blocked";
				records.append("product", "case.blocked", { verdicts });
				return state;
			}
			if (verdicts.every((verdict) => verdict.decision === "pass")) {
				state.status = "completed";
				records.append("product", "case.completed", { artifact });
				return state;
			}

			state.status = "revising";
			records.append("product", "case.revision-requested", { verdicts });
		}

		state.status = "exhausted";
		records.append("product", "case.exhausted", {
			maxIterations: charter.maxIterations,
		});
		return state;
	}

	async #auditAtScale(
		input: AuditInput,
		records: RecordsOffice,
	): Promise<AuditVerdict[]> {
		const attempts = await Promise.all(
			this.#policy.audit.primary.map(async (route) => {
				try {
					const verdict = await this.#runner.audit(input, route);
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
			await this.#withFallback(
				"audit",
				this.#policy.audit.fallback,
				(route) => this.#runner.audit(input, route),
				records,
			),
		];
	}

	async #withFallback<T>(
		role: OfficeRole,
		routes: readonly ModelRoute[],
		run: (route: ModelRoute) => Promise<T>,
		records: RecordsOffice,
	): Promise<T> {
		for (const route of routes) {
			try {
				const output = await run(route);
				records.append(
					"process",
					"model.succeeded",
					{},
					{ role, route },
				);
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
}
