import type {
	CaseState,
	ModelRoute,
	MugamaaRecord,
	OfficeRole,
	RecordCategory,
} from "./types.ts";

export class RecordsOffice {
	readonly #state: CaseState;
	readonly #now: () => number;

	constructor(state: CaseState, now: () => number) {
		this.#state = state;
		this.#now = now;
	}

	append(
		category: RecordCategory,
		type: string,
		payload: unknown,
		options: { role?: OfficeRole; route?: ModelRoute } = {},
	): MugamaaRecord {
		const record: MugamaaRecord = {
			seq: this.#state.records.length + 1,
			at: this.#now(),
			caseId: this.#state.charter.id,
			iteration: this.#state.iteration,
			category,
			type,
			...options,
			payload,
		};
		this.#state.records.push(record);
		return record;
	}
}
