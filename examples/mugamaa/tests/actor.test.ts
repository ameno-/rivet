import { randomUUID } from "node:crypto";
import { setup } from "rivetkit";
import { setupTest } from "rivetkit/test";
import { expect, test, vi } from "vitest";
import { createMugamaaActor } from "../src/actor.ts";
import { DEFAULT_MODEL_POLICY } from "../src/model-policy.ts";
import { durableStorageIssue } from "../src/sample.ts";
import type {
	AuditInput,
	ModelRoute,
	OfficeRunner,
	PlanningInput,
	WorksInput,
} from "../src/types.ts";

const runner: OfficeRunner = {
	plan: async (input: PlanningInput, _route: ModelRoute) => ({
		summary: "Produce the contract",
		tasks: ["Define ownership", "Define transaction boundaries"],
		successConditions: input.charter.acceptanceCriteria,
	}),
	work: async (_input: WorksInput, _route: ModelRoute) => ({
		summary: "Contract",
		body: "One actor owns the adapter and its SQLite transactions.",
		evidence: ["actor runtime receipt"],
	}),
	audit: async (_input: AuditInput, _route: ModelRoute) => ({
		decision: "pass",
		rationale: "The seed actor completed its bounded workflow.",
		findings: [],
	}),
};

const mugamaa = createMugamaaActor(runner, DEFAULT_MODEL_POLICY);
const registry = setup({ use: { mugamaa } });

test("a Rivet Actor runs one charter to a durable terminal snapshot", async (context) => {
	const { client } = await setupTest(context, registry);
	const handle = await client.mugamaa.create(["seed", randomUUID()], {
		input: {
			...durableStorageIssue,
			id: `actor-${randomUUID()}`,
			maxIterations: 1,
		},
	});

	await vi.waitFor(
		async () => {
			expect((await handle.getSnapshot()).status).toBe("completed");
		},
		{ timeout: 20_000 },
	);

	const snapshot = await handle.getSnapshot();
	expect(snapshot.records.at(-1)?.type).toBe("case.completed");
	expect(
		snapshot.records.some((record) => record.category === "process"),
	).toBe(true);
}, 20_000);
