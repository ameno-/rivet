/**
 * Manual operator surface for Mugamaa v0.2 Phase 4.
 *
 * The operator is the smallest useful command-line front-end on top of
 * the case protocol. It does exactly two things:
 *
 * 1. `runOperator` -- load a Goal Charter JSON, load an explicit
 *    {@link OfficeRunner} module, execute one bounded case through the
 *    standard engine, persist the complete {@link CaseState} receipt,
 *    and return a concise summary the CLI can print.
 *
 * 2. `inspectOperator` -- read a previously persisted receipt by case
 *    id, validate just enough structure to reject corrupt files, and
 *    return the receipt for inspection.
 *
 * The operator never sources the runner module on its own; the caller
 * supplies the path. The operator also never touches credentials, base
 * URLs, or external configuration -- the receipts are plain
 * {@link CaseState} JSON.
 */

import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import {
	CaseReceiptStore,
	type CaseReceiptStoreOptions,
} from "./case-receipt-store.ts";
import {
	CharterValidationError,
	validateGoalCharter,
} from "./charter-validation.ts";
import { Mugamaa } from "./engine.ts";
import { DEFAULT_MODEL_POLICY } from "./model-policy.ts";
import { loadOfficeRunner, RunnerModuleError } from "./runner-module.ts";
import type { CaseState, ModelPolicy } from "./types.ts";

export class OperatorError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "OperatorError";
		this.code = code;
	}
}

export interface RunOperatorOptions {
	/** Absolute or process-relative path to the Goal Charter JSON. */
	charterPath: string;
	/** Absolute or process-relative path to the runner module. */
	runnerModulePath: string;
	/** Directory used to persist the receipt. */
	recordsDir: string;
	/** Optional model policy override. Defaults to {@link DEFAULT_MODEL_POLICY}. */
	policy?: ModelPolicy;
	/** Optional `Date.now()` substitute for deterministic tests. */
	now?: () => number;
}

export interface OperatorRunSummary {
	caseId: string;
	status: CaseState["status"];
	iteration: number;
	recordCount: number;
	artifact: {
		summary: string;
		bodyLength: number;
		evidence: number;
	} | null;
	receiptPath: string;
}

/**
 * Execute one Goal Charter through the standard Mugamaa engine using
 * the supplied runner module and persist the resulting CaseState.
 */
export async function runOperator(
	options: RunOperatorOptions,
): Promise<OperatorRunSummary> {
	const charter = await loadCharterFromFile(options.charterPath);
	const runner = await loadOfficeRunner({
		modulePath: options.runnerModulePath,
	});
	const policy = options.policy ?? DEFAULT_MODEL_POLICY;
	const now = options.now ?? Date.now;
	const store = createStore({ recordsDir: options.recordsDir });

	const mugamaa = new Mugamaa({ policy, runner, now });
	const state = await mugamaa.run(charter);
	const receiptPath = await store.writeReceipt(state.charter.id, state);

	return summarizeRun(state, receiptPath);
}

export interface InspectOperatorOptions {
	caseId: string;
	recordsDir: string;
}

export interface OperatorInspectSummary {
	caseId: string;
	status: CaseState["status"];
	iteration: number;
	charterId: string;
	artifact: {
		summary: string;
		bodyLength: number;
		evidence: number;
	} | null;
	recordCount: number;
	receiptPath: string;
}

/**
 * Read a persisted receipt by case id and return a concise summary
 * alongside the full state.
 */
export async function inspectOperator(
	options: InspectOperatorOptions,
): Promise<{
	summary: OperatorInspectSummary;
	state: CaseState;
}> {
	const store = createStore({ recordsDir: options.recordsDir });
	const state = await store.readReceipt(options.caseId);
	return {
		summary: summarizeInspect(state, store.resolvePath(options.caseId)),
		state,
	};
}

export function summarizeRun(
	state: CaseState,
	receiptPath: string,
): OperatorRunSummary {
	const artifact = state.artifact
		? {
				summary: state.artifact.summary,
				bodyLength: state.artifact.body.length,
				evidence: state.artifact.evidence.length,
			}
		: null;
	return {
		caseId: state.charter.id,
		status: state.status,
		iteration: state.iteration,
		recordCount: state.records.length,
		artifact,
		receiptPath,
	};
}

export function summarizeInspect(
	state: CaseState,
	receiptPath: string,
): OperatorInspectSummary {
	const artifact = state.artifact
		? {
				summary: state.artifact.summary,
				bodyLength: state.artifact.body.length,
				evidence: state.artifact.evidence.length,
			}
		: null;
	return {
		caseId: state.charter.id,
		charterId: state.charter.id,
		status: state.status,
		iteration: state.iteration,
		artifact,
		recordCount: state.records.length,
		receiptPath,
	};
}

async function loadCharterFromFile(
	path: string,
): Promise<ReturnType<typeof validateGoalCharter>> {
	const absolute = resolvePath(path);
	let raw: string;
	try {
		raw = await readFile(absolute, "utf8");
	} catch (error) {
		throw new OperatorError(
			"charter_unreadable",
			`Could not read charter at ${absolute}: ${describeError(error)}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new OperatorError(
			"charter_invalid_json",
			`Charter at ${absolute} is not valid JSON: ${describeError(error)}`,
		);
	}
	try {
		return validateGoalCharter(parsed);
	} catch (error) {
		if (error instanceof CharterValidationError) {
			throw new OperatorError("charter_invalid_shape", error.message);
		}
		throw error;
	}
}

function createStore(options: CaseReceiptStoreOptions): CaseReceiptStore {
	return new CaseReceiptStore(options);
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export { RunnerModuleError, CharterValidationError };
export {
	assertSafeCaseId,
	CaseReceiptError,
	CaseReceiptStore,
} from "./case-receipt-store.ts";
export { validateGoalCharter } from "./charter-validation.ts";
export { loadOfficeRunner } from "./runner-module.ts";
export type {
	OperatorRunSummary as RunSummary,
	OperatorInspectSummary as InspectSummary,
};
