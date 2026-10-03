import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectOperator, runOperator } from "../src/operator.ts";
import { main, parseArgs } from "../src/operator-cli.ts";
import { loadOfficeRunner, RunnerModuleError } from "../src/runner-module.ts";
import {
	captureStdStreams,
	cleanupFixtureDir,
	freshFixtureDir,
	writeCharterFile,
	writePassingRunnerModule,
	writeRunnerModule,
	writeThrowingAuditRunnerModule,
} from "./operator.fakes.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) cleanupFixtureDir(dir);
});

const charterBody = {
	id: "operator-case",
	title: "Operator case",
	objective: "Run one explicit charter",
	acceptanceCriteria: ["Receipt is inspectable"],
	constraints: [],
	maxIterations: 1,
};

function fixture(label: string) {
	const dir = freshFixtureDir(label);
	dirs.push(dir);
	return {
		dir,
		charter: writeCharterFile(dir, "goal", charterBody),
		runner: writePassingRunnerModule(dir),
		records: join(dir, "records"),
	};
}

describe("runner module loading", () => {
	it("loads direct and async factory runner exports", async () => {
		const direct = fixture("runner-direct");
		expect(
			typeof (await loadOfficeRunner({ modulePath: direct.runner })).plan,
		).toBe("function");

		const factoryDir = freshFixtureDir("runner-factory");
		dirs.push(factoryDir);
		const modulePath = writeRunnerModule(
			factoryDir,
			`export async function createRunner() { return {
  plan: async () => ({ summary: "p", tasks: ["t"], successConditions: ["c"] }),
  work: async () => ({ summary: "a", body: "b", evidence: [] }),
  audit: async () => ({ decision: "pass", rationale: "ok", findings: [] }),
}; }`,
		);
		expect(typeof (await loadOfficeRunner({ modulePath })).audit).toBe(
			"function",
		);
	});

	it("rejects missing modules and invalid exports", async () => {
		await expect(
			loadOfficeRunner({ modulePath: "/tmp/mugamaa-does-not-exist.mjs" }),
		).rejects.toBeInstanceOf(RunnerModuleError);
		const dir = freshFixtureDir("runner-invalid");
		dirs.push(dir);
		const invalid = writeRunnerModule(
			dir,
			"export const runner = { plan() {} };",
		);
		await expect(loadOfficeRunner({ modulePath: invalid })).rejects.toThrow(
			/missing work/,
		);
	});
});

describe("operator API", () => {
	it("runs a charter, writes a receipt, and inspects the same state", async () => {
		const item = fixture("operator-run");
		const summary = await runOperator({
			charterPath: item.charter,
			runnerModulePath: item.runner,
			recordsDir: item.records,
			now: () => 1,
		});
		expect(summary).toMatchObject({
			caseId: "operator-case",
			status: "completed",
			iteration: 1,
		});
		await expect(access(summary.receiptPath)).resolves.toBeUndefined();
		const inspected = await inspectOperator({
			caseId: "operator-case",
			recordsDir: item.records,
		});
		expect(inspected.summary.recordCount).toBe(summary.recordCount);
		expect(inspected.state.charter.id).toBe("operator-case");
	});

	it("does not write a partial receipt when a runner fails", async () => {
		const item = fixture("operator-failure");
		const throwing = writeThrowingAuditRunnerModule(item.dir);
		await expect(
			runOperator({
				charterPath: item.charter,
				runnerModulePath: throwing,
				recordsDir: item.records,
			}),
		).rejects.toThrow("audit exploded");
		await expect(
			access(join(item.records, "operator-case.case.json")),
		).rejects.toThrow();
	});

	it("reports invalid charter JSON", async () => {
		const item = fixture("operator-invalid-charter");
		await writeFile(item.charter, "{");
		await expect(
			runOperator({
				charterPath: item.charter,
				runnerModulePath: item.runner,
				recordsDir: item.records,
			}),
		).rejects.toMatchObject({ code: "charter_invalid_json" });
	});
});

describe("operator CLI", () => {
	it("parses supported long options", () => {
		expect(
			parseArgs([
				"run",
				"goal.json",
				"--runner-module=runner.ts",
				"--records-dir",
				"records",
			]),
		).toEqual({
			command: "run",
			positionals: ["goal.json"],
			options: { "runner-module": "runner.ts", "records-dir": "records" },
		});
	});

	it("prints run and inspect summaries without spawning a process", async () => {
		const item = fixture("operator-cli");
		const capture = captureStdStreams();
		try {
			expect(
				await main([
					"run",
					item.charter,
					"--runner-module",
					item.runner,
					"--records-dir",
					item.records,
				]),
			).toBe(0);
			expect(JSON.parse(capture.stdout()).caseId).toBe("operator-case");
		} finally {
			capture.restore();
		}

		const inspectCapture = captureStdStreams();
		try {
			expect(
				await main([
					"inspect",
					"operator-case",
					"--records-dir",
					item.records,
				]),
			).toBe(0);
			expect(JSON.parse(inspectCapture.stdout()).status).toBe(
				"completed",
			);
		} finally {
			inspectCapture.restore();
		}
	});

	it.each<{ argv: string[] }>([
		{ argv: [] },
		{ argv: ["unknown"] },
		{ argv: ["run", "goal.json"] },
		{ argv: ["inspect"] },
	])("returns usage failure for $argv", async ({ argv }) => {
		const capture = captureStdStreams();
		try {
			expect(await main(argv)).toBe(1);
			expect(JSON.parse(capture.stderr()).code).toBe("usage");
		} finally {
			capture.restore();
		}
	});
});
