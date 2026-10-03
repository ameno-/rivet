import type { AuditVerdict, ProductArtifact, WorkOrder } from "./types.ts";

/**
 * Strict parsers for the three structured Mugamaa outputs. The parsers are
 * pure: they consume a raw provider body string and either return the typed
 * object or a typed failure. The live runner rejects the response (and
 * deliberately does not fall back) whenever the parser refuses to accept
 * the body.
 */

export type OutputParseResult<T> =
	| { ok: true; value: T }
	| { ok: false; reason: string };

export function parseWorkOrder(raw: string): OutputParseResult<WorkOrder> {
	const stripped = stripFences(raw);
	const value = tryJson(stripped);
	if (!value.ok) return value;
	const parsed = value.value;
	if (!isObject(parsed)) return fail("WorkOrder must be an object");
	const summary = stringField(parsed, "summary");
	if (!summary.ok) return summary;
	const tasks = stringArrayField(parsed, "tasks");
	if (!tasks.ok) return tasks;
	const success = stringArrayField(parsed, "successConditions");
	if (!success.ok) return success;
	if (tasks.value.length === 0)
		return fail("WorkOrder tasks must not be empty");
	if (success.value.length === 0)
		return fail("WorkOrder successConditions must not be empty");
	return {
		ok: true,
		value: {
			summary: summary.value,
			tasks: tasks.value,
			successConditions: success.value,
		},
	};
}

export function parseProductArtifact(
	raw: string,
): OutputParseResult<ProductArtifact> {
	const stripped = stripFences(raw);
	const value = tryJson(stripped);
	if (!value.ok) return value;
	const parsed = value.value;
	if (!isObject(parsed)) return fail("ProductArtifact must be an object");
	const summary = stringField(parsed, "summary");
	if (!summary.ok) return summary;
	const body = stringField(parsed, "body");
	if (!body.ok) return body;
	const evidence = stringArrayField(parsed, "evidence");
	if (!evidence.ok) return evidence;
	return {
		ok: true,
		value: {
			summary: summary.value,
			body: body.value,
			evidence: evidence.value,
		},
	};
}

export function parseAuditVerdict(
	raw: string,
): OutputParseResult<AuditVerdict> {
	const stripped = stripFences(raw);
	const value = tryJson(stripped);
	if (!value.ok) return value;
	const parsed = value.value;
	if (!isObject(parsed)) return fail("AuditVerdict must be an object");
	const decisionField = rawStringField(parsed, "decision");
	if (!decisionField.ok) return decisionField;
	if (
		decisionField.value !== "pass" &&
		decisionField.value !== "revise" &&
		decisionField.value !== "blocked"
	) {
		return fail("AuditVerdict decision must be pass, revise, or blocked");
	}
	const rationale = stringField(parsed, "rationale");
	if (!rationale.ok) return rationale;
	const findings = stringArrayField(parsed, "findings");
	if (!findings.ok) return findings;
	return {
		ok: true,
		value: {
			decision: decisionField.value,
			rationale: rationale.value,
			findings: findings.value,
		},
	};
}

function stripFences(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed.startsWith("```")) return trimmed;
	const firstNewline = trimmed.indexOf("\n");
	const lastFence = trimmed.lastIndexOf("```");
	if (firstNewline < 0 || lastFence <= firstNewline) return trimmed;
	return trimmed.slice(firstNewline + 1, lastFence).trim();
}

function tryJson(raw: string): OutputParseResult<unknown> {
	try {
		return { ok: true, value: JSON.parse(raw) };
	} catch (error) {
		const reason =
			error instanceof Error ? error.message : "unknown parse error";
		return fail(`Invalid JSON: ${reason}`);
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
	obj: Record<string, unknown>,
	key: string,
): OutputParseResult<string> {
	const raw = rawStringField(obj, key);
	if (!raw.ok) return raw;
	if (raw.value.length === 0) return fail(`${key} must not be empty`);
	return raw;
}

function rawStringField(
	obj: Record<string, unknown>,
	key: string,
): OutputParseResult<string> {
	const value = obj[key];
	if (typeof value !== "string") return fail(`${key} must be a string`);
	return { ok: true, value };
}

function stringArrayField(
	obj: Record<string, unknown>,
	key: string,
): OutputParseResult<string[]> {
	const value = obj[key];
	if (!Array.isArray(value))
		return fail(`${key} must be an array of strings`);
	for (const entry of value) {
		if (typeof entry !== "string")
			return fail(`${key} must be an array of strings`);
	}
	return { ok: true, value: value as string[] };
}

function fail(reason: string): OutputParseResult<never> {
	return { ok: false, reason };
}
