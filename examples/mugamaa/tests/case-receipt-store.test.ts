import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertSafeCaseId,
	CaseReceiptError,
	CaseReceiptStore,
} from "../src/case-receipt-store.ts";
import { Mugamaa } from "../src/engine.ts";
import { DEFAULT_MODEL_POLICY } from "../src/model-policy.ts";
import type { CaseState, GoalCharter } from "../src/types.ts";
import {
	cleanupFixtureDir,
	freshFixtureDir,
	passingOfficeRunner,
} from "./operator.fakes.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) cleanupFixtureDir(dir);
});

const charter: GoalCharter = {
	id: "receipt-case",
	title: "Receipt case",
	objective: "Persist one completed Mugamaa receipt",
	acceptanceCriteria: ["Receipt round-trips"],
	constraints: [],
	maxIterations: 1,
};

async function completedState(): Promise<CaseState> {
	return await new Mugamaa({
		policy: DEFAULT_MODEL_POLICY,
		runner: passingOfficeRunner(),
		now: () => 1,
	}).run(charter);
}

describe("CaseReceiptStore", () => {
	it("writes and reads a complete receipt", async () => {
		const dir = freshFixtureDir("receipt-roundtrip");
		dirs.push(dir);
		const store = new CaseReceiptStore({ recordsDir: dir });
		const state = await completedState();
		const path = await store.writeReceipt(state.charter.id, state);
		expect(await store.readReceipt(state.charter.id)).toEqual(state);
		expect(path).toBe(join(dir, "receipt-case.case.json"));
	});

	it("atomically replaces the receipt for the same case id", async () => {
		const dir = freshFixtureDir("receipt-replace");
		dirs.push(dir);
		const store = new CaseReceiptStore({ recordsDir: dir });
		const first = await completedState();
		await store.writeReceipt(first.charter.id, first);
		const second = { ...first, iteration: 7 };
		await store.writeReceipt(second.charter.id, second);
		expect((await store.readReceipt(second.charter.id)).iteration).toBe(7);
		const entries = await readFile(
			store.resolvePath(second.charter.id),
			"utf8",
		);
		expect(JSON.parse(entries).iteration).toBe(7);
	});

	it.each([
		"../escape",
		"/absolute",
		"has/slash",
		"",
		".hidden",
	])("rejects unsafe case id %j", (caseId) => {
		expect(() => assertSafeCaseId(caseId)).toThrow(CaseReceiptError);
	});

	it("reports missing and corrupt receipts", async () => {
		const dir = freshFixtureDir("receipt-errors");
		dirs.push(dir);
		const store = new CaseReceiptStore({ recordsDir: dir });
		await expect(store.readReceipt("missing-case")).rejects.toThrow(
			/No receipt found/,
		);
		await writeFile(join(dir, "corrupt.case.json"), "not json");
		await expect(store.readReceipt("corrupt")).rejects.toThrow(
			/not valid JSON/,
		);
	});

	it("rejects structurally invalid receipt JSON", async () => {
		const dir = freshFixtureDir("receipt-shape");
		dirs.push(dir);
		const store = new CaseReceiptStore({ recordsDir: dir });
		await writeFile(
			join(dir, "bad-shape.case.json"),
			JSON.stringify({
				charter: {},
				status: "mystery",
				records: [],
				verdicts: [],
			}),
		);
		await expect(store.readReceipt("bad-shape")).rejects.toThrow(
			/unknown status/,
		);
	});

	it("does not introduce credential or base URL fields", async () => {
		const dir = freshFixtureDir("receipt-secrets");
		dirs.push(dir);
		const store = new CaseReceiptStore({ recordsDir: dir });
		const state = await completedState();
		const path = await store.writeReceipt(state.charter.id, state);
		const raw = await readFile(path, "utf8");
		expect(raw).not.toMatch(/apiKey|authorization|baseUrl|bearer/i);
	});
});
