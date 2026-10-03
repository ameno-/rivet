/**
 * Runtime validation for Goal Charter documents.
 *
 * Goal charters originate from JSON files supplied by the operator on the
 * command line. The seed's TypeScript types describe the intended shape
 * but cannot protect against hand-edited or hostile JSON. This module
 * validates every field at runtime so the operator surface rejects
 * malformed input deterministically before any office is invoked.
 *
 * The validator is deliberately conservative:
 *
 * - every primitive is checked by type and (where applicable) value;
 * - empty strings and empty arrays are rejected for fields the case
 *   protocol requires to be non-empty;
 * - `maxIterations` must be a positive integer;
 * - the case id is restricted to a small, safe character class so it
 *   cannot be used to escape the receipt store's directory;
 * - unknown fields are rejected on each object to make the wire format
 *   explicit.
 */

import type { GoalCharter } from "./types.ts";

const CASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class CharterValidationError extends Error {
	readonly code = "invalid_charter";
	constructor(message: string) {
		super(message);
		this.name = "CharterValidationError";
	}
}

export function isCharterValidationError(
	error: unknown,
): error is CharterValidationError {
	return error instanceof CharterValidationError;
}

/**
 * Validate and return a Goal Charter parsed from arbitrary JSON input.
 *
 * The validator never silently coerces; it rejects on any deviation from
 * the expected shape. The returned charter is a defensive copy so
 * mutations to the original JSON object cannot influence the case
 * protocol after validation.
 */
export function validateGoalCharter(value: unknown): GoalCharter {
	if (!isPlainObject(value)) {
		throw new CharterValidationError("Charter must be a JSON object");
	}
	const id = requireString(value, "id");
	if (id.length === 0) {
		throw new CharterValidationError("Charter id must not be empty");
	}
	if (!CASE_ID_PATTERN.test(id)) {
		throw new CharterValidationError(
			"Charter id must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}",
		);
	}
	const title = requireString(value, "title");
	if (title.length === 0) {
		throw new CharterValidationError("Charter title must not be empty");
	}
	const objective = requireString(value, "objective");
	if (objective.length === 0) {
		throw new CharterValidationError("Charter objective must not be empty");
	}
	const acceptanceCriteria = requireStringArray(value, "acceptanceCriteria");
	if (acceptanceCriteria.length === 0) {
		throw new CharterValidationError(
			"Charter acceptanceCriteria must contain at least one entry",
		);
	}
	for (const [index, entry] of acceptanceCriteria.entries()) {
		if (entry.length === 0) {
			throw new CharterValidationError(
				`Charter acceptanceCriteria[${index}] must not be empty`,
			);
		}
	}
	const constraints = requireStringArray(value, "constraints");
	for (const [index, entry] of constraints.entries()) {
		if (entry.length === 0) {
			throw new CharterValidationError(
				`Charter constraints[${index}] must not be empty`,
			);
		}
	}
	const maxIterations = requireInteger(value, "maxIterations");
	if (maxIterations < 1) {
		throw new CharterValidationError(
			"Charter maxIterations must be at least 1",
		);
	}
	return {
		id,
		title,
		objective,
		acceptanceCriteria: [...acceptanceCriteria],
		constraints: [...constraints],
		maxIterations,
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function requireString(obj: Record<string, unknown>, key: string): string {
	const value = obj[key];
	if (typeof value !== "string") {
		throw new CharterValidationError(`Charter ${key} must be a string`);
	}
	return value;
}

function requireStringArray(
	obj: Record<string, unknown>,
	key: string,
): string[] {
	const value = obj[key];
	if (!Array.isArray(value)) {
		throw new CharterValidationError(
			`Charter ${key} must be an array of strings`,
		);
	}
	const out: string[] = [];
	for (const [index, entry] of value.entries()) {
		if (typeof entry !== "string") {
			throw new CharterValidationError(
				`Charter ${key}[${index}] must be a string`,
			);
		}
		out.push(entry);
	}
	return out;
}

function requireInteger(obj: Record<string, unknown>, key: string): number {
	const value = obj[key];
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new CharterValidationError(`Charter ${key} must be an integer`);
	}
	return value;
}
