import { describe, expect, it } from "vitest";
import {
	auditPrompt,
	planningPrompt,
	worksPrompt,
} from "../src/office-prompts.ts";
import type { AuditInput, WorksInput } from "../src/types.ts";

describe("worksPrompt", () => {
	it("carries the complete charter contract into the Works Office", () => {
		const input: WorksInput = {
			charter: {
				id: "case-1",
				title: "Durable contract",
				objective: "Define the storage contract",
				acceptanceCriteria: ["Reopens committed state"],
				constraints: ["Keep AgentSession compatible"],
				maxIterations: 2,
			},
			iteration: 1,
			previousVerdicts: [],
			workOrder: {
				summary: "Write it",
				tasks: ["Map records"],
				successConditions: ["Contract is explicit"],
			},
		};

		const prompt = worksPrompt(input);
		expect(prompt).toContain("You have no tools or external context");
		expect(prompt).toContain("Charter title: Durable contract");
		expect(prompt).toContain(
			"Charter acceptance criteria: Reopens committed state",
		);
		expect(prompt).toContain(
			"Charter constraints: Keep AgentSession compatible",
		);
	});

	it("carries the contract into Planning and Audit offices", () => {
		const worksInput: WorksInput = {
			charter: {
				id: "case-1",
				title: "Durable contract",
				objective: "Define the storage contract",
				acceptanceCriteria: ["Reopens committed state"],
				constraints: ["Keep AgentSession compatible"],
				maxIterations: 2,
			},
			iteration: 1,
			previousVerdicts: [],
			workOrder: {
				summary: "Write it",
				tasks: ["Map records"],
				successConditions: ["Contract is explicit"],
			},
		};
		const planning = planningPrompt(worksInput);
		expect(planning).toContain("You have no tools or external context");
		expect(planning).toContain(
			"Charter constraints: Keep AgentSession compatible",
		);

		const auditInput: AuditInput = {
			charter: worksInput.charter,
			iteration: 1,
			workOrder: worksInput.workOrder,
			artifact: { summary: "Contract", body: "Body", evidence: [] },
		};
		const audit = auditPrompt(auditInput);
		expect(audit).toContain("You have no tools or external context");
		expect(audit).toContain(
			"Charter constraints: Keep AgentSession compatible",
		);
	});
});
