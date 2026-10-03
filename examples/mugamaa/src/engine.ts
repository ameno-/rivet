import {
	decidePhaseOutcome,
	initializeCase,
	recordCaseExhausted,
	runAuditPhase,
	runPlanningPhase,
	runWorksPhase,
} from "./phases.ts";
import { RecordsOffice } from "./records.ts";
import type {
	CaseState,
	GoalCharter,
	ModelPolicy,
	OfficeRunner,
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
		initializeCase(state, records);

		for (
			let iteration = 1;
			iteration <= charter.maxIterations;
			iteration++
		) {
			state.iteration = iteration;
			await runPlanningPhase(state, records, this.#runner, this.#policy);
			await runWorksPhase(state, records, this.#runner, this.#policy);
			await runAuditPhase(state, records, this.#runner, this.#policy);
			const decision = decidePhaseOutcome(state, records);
			if (
				decision.outcome.kind === "complete" ||
				decision.outcome.kind === "blocked"
			) {
				return state;
			}
			if (iteration === charter.maxIterations) {
				recordCaseExhausted(state, records);
				return state;
			}
		}

		// Defensive fallback: the bounded loop returns on its final iteration.
		recordCaseExhausted(state, records);
		return state;
	}
}
