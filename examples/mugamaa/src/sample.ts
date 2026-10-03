import { Mugamaa } from "./engine.ts";
import { DEFAULT_MODEL_POLICY } from "./model-policy.ts";
import type {
	AuditInput,
	AuditVerdict,
	GoalCharter,
	ModelRoute,
	OfficeRunner,
	PlanningInput,
	ProductArtifact,
	WorkOrder,
	WorksInput,
} from "./types.ts";

export const durableStorageIssue: GoalCharter = {
	id: "github-ameno-rivet-2",
	title: "Define the durable storage adapter contract",
	objective:
		"Define how Pi Durable storage maps to Rivet Actor SQLite without weakening the actor single-writer invariant.",
	acceptanceCriteria: [
		"Map every Pi Durable record to Rivet ownership.",
		"Define atomic transaction and sequence behavior.",
		"Specify migration and rollback conditions.",
		"Describe conformance and query-efficiency coverage.",
	],
	constraints: [
		"Do not replace the existing AgentSession API.",
		"Do not implement model or tool replay in this task.",
	],
	maxIterations: 2,
};

class StorageContractOffices implements OfficeRunner {
	async plan(input: PlanningInput, _route: ModelRoute): Promise<WorkOrder> {
		const revision = input.previousVerdicts.flatMap(
			(verdict) => verdict.findings,
		);
		return {
			summary:
				revision.length === 0
					? "Draft the adapter contract"
					: "Revise the contract from audit findings",
			tasks: [
				"Define record and table ownership",
				"Define commit and cursor semantics",
				"Define conformance evidence",
				...(revision.length > 0
					? ["Add explicit rollback eligibility and procedure"]
					: []),
			],
			successConditions: input.charter.acceptanceCriteria,
		};
	}

	async work(
		input: WorksInput,
		_route: ModelRoute,
	): Promise<ProductArtifact> {
		const rollback =
			input.iteration > 1
				? "Rollback: retain the legacy tables, gate durable mode explicitly, and reverse only before durable-only writes are admitted."
				: "";
		return {
			summary: `Storage adapter contract draft ${input.iteration}`,
			body: [
				"Ownership: one Rivet Actor is the sole writer for its Pi Durable session.",
				"Storage: conversations, entries, documents, submissions, and tasks use actor SQLite tables.",
				"Transactions: one adapter transaction maps to one actor SQLite transaction and advances a shared sequence.",
				"Verification: run Pi Durable storage conformance plus production-query plan assertions.",
				rollback,
			]
				.filter(Boolean)
				.join("\n"),
			evidence: [
				"Pi Durable storage conformance suite",
				"Rivet SQLite single-writer invariant",
			],
		};
	}

	async audit(input: AuditInput, route: ModelRoute): Promise<AuditVerdict> {
		if (input.iteration === 1 && route.model === "glm-5.3-flash") {
			return {
				decision: "revise",
				rationale:
					"The contract does not yet define when rollback remains safe.",
				findings: ["Add explicit rollback eligibility and procedure."],
			};
		}
		return {
			decision: "pass",
			rationale:
				"The contract addresses ownership, transactions, verification, and rollback.",
			findings: [],
		};
	}
}

export async function runSample() {
	return await new Mugamaa({
		policy: DEFAULT_MODEL_POLICY,
		runner: new StorageContractOffices(),
	}).run(durableStorageIssue);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const result = await runSample();
	console.log(JSON.stringify(result, null, 2));
}
