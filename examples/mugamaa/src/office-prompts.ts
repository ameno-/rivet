import type { AuditInput, PlanningInput, WorksInput } from "./types.ts";

/**
 * Prompt builders are pure: each function takes the structured Mugamaa input
 * and returns a self-contained instruction string. Providers, credentials,
 * and base URLs never enter these prompts.
 */

export function planningPrompt(input: PlanningInput): string {
	const previousArtifact = input.previousArtifact
		? `\nPrevious artifact summary: ${input.previousArtifact.summary}\nPrevious artifact body: ${input.previousArtifact.body}\nPrevious evidence: ${input.previousArtifact.evidence.join("; ")}`
		: "";
	const previousFindings =
		input.previousVerdicts.length > 0
			? `\nPrevious audit findings: ${input.previousVerdicts
					.flatMap((verdict) => verdict.findings)
					.join("; ")}`
			: "";
	return [
		"You are the planning office for one Goal Charter.",
		"You have no tools or external context. Do not announce or defer work; use only the supplied text and answer now.",
		"Produce exactly one JSON object, no prose, no markdown fences.",
		'The object must match: {"summary": string, "tasks": string[], "successConditions": string[]}.',
		`Charter id: ${input.charter.id}`,
		`Charter title: ${input.charter.title}`,
		`Charter objective: ${input.charter.objective}`,
		`Charter acceptance criteria: ${input.charter.acceptanceCriteria.join("; ")}`,
		`Charter constraints: ${input.charter.constraints.join("; ")}`,
		`Iteration: ${input.iteration}`,
		previousArtifact,
		previousFindings,
	].join("\n");
}

export function worksPrompt(input: WorksInput): string {
	const previousArtifact = input.previousArtifact
		? `\nPrevious artifact summary: ${input.previousArtifact.summary}`
		: "";
	return [
		"You are the works office for one Goal Charter.",
		"You have no tools or external context. Do not announce or defer work; use only the supplied text and answer now.",
		"Produce exactly one JSON object, no prose, no markdown fences.",
		'The object must match: {"summary": string, "body": string, "evidence": string[]}.',
		`Charter id: ${input.charter.id}`,
		`Charter title: ${input.charter.title}`,
		`Charter objective: ${input.charter.objective}`,
		`Charter acceptance criteria: ${input.charter.acceptanceCriteria.join("; ")}`,
		`Charter constraints: ${input.charter.constraints.join("; ")}`,
		`Work order summary: ${input.workOrder.summary}`,
		`Work order tasks: ${input.workOrder.tasks.join("; ")}`,
		`Work order success conditions: ${input.workOrder.successConditions.join("; ")}`,
		`Iteration: ${input.iteration}`,
		previousArtifact,
	].join("\n");
}

export function auditPrompt(input: AuditInput): string {
	return [
		"You are the audit office for one Goal Charter.",
		"You have no tools or external context. Do not announce or defer work; use only the supplied text and answer now.",
		"Produce exactly one JSON object, no prose, no markdown fences.",
		'The object must match: {"decision": "pass"|"revise"|"blocked", "rationale": string, "findings": string[]}.',
		`Charter id: ${input.charter.id}`,
		`Charter objective: ${input.charter.objective}`,
		`Charter acceptance criteria: ${input.charter.acceptanceCriteria.join("; ")}`,
		`Charter constraints: ${input.charter.constraints.join("; ")}`,
		`Work order summary: ${input.workOrder.summary}`,
		`Artifact summary: ${input.artifact.summary}`,
		`Artifact body: ${input.artifact.body}`,
		`Artifact evidence: ${input.artifact.evidence.join("; ")}`,
		`Iteration: ${input.iteration}`,
	].join("\n");
}
