/**
 * Shared fakes and helpers for the Mugamaa operator-surface tests.
 *
 * The operator, runner-module loader, and CLI tests all need the same
 * kind of deterministic OfficeRunner fixture module: a small TypeScript
 * file written into a unique temp directory and torn down with the test.
 * Centralising the builders keeps every test deterministic and prevents
 * the runner fixtures from leaking into other suites.
 *
 * The fakes intentionally mirror the production model: the same office
 * shape used by the phases tests is reused here so the operator surface
 * never has to invent a new runner contract.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AuditInput,
	AuditVerdict,
	ModelRoute,
	OfficeRunner,
	PlanningInput,
	ProductArtifact,
	WorkOrder,
	WorksInput,
} from "../src/types.ts";

/**
 * Build a unique directory under the OS temp dir for one fixture file.
 * The caller is responsible for invoking {@link cleanupFixture} when the
 * test finishes so the OS temp dir never fills up with fixtures.
 */
export function freshFixtureDir(label: string): string {
	const base = join(
		tmpdir(),
		`mugamaa-op-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	mkdirSync(base, { recursive: true });
	return base;
}

export function cleanupFixtureDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// The fixture is best-effort: the OS will eventually reap /tmp.
	}
}

/** Write a runner fixture module with the given source body. */
export function writeRunnerModule(dir: string, source: string): string {
	const path = join(dir, "runner.ts");
	writeFileSync(path, source);
	return path;
}

/** Write a Goal Charter JSON file with the given object body. */
export function writeCharterFile(
	dir: string,
	name: string,
	body: Record<string, unknown>,
): string {
	const path = join(dir, `${name}.charter.json`);
	writeFileSync(path, JSON.stringify(body));
	return path;
}

export interface OfficeResponses {
	plan: WorkOrder;
	work: ProductArtifact;
	audit: AuditVerdict;
}

/**
 * An OfficeRunner that returns the supplied static responses for every
 * call. Used by the operator tests because the runner contract is the
 * only thing exercised end-to-end; the engine itself is covered by the
 * phases and seed suites.
 */
export function staticOfficeRunner(responses: OfficeResponses): OfficeRunner {
	return {
		async plan(
			_input: PlanningInput,
			_route: ModelRoute,
		): Promise<WorkOrder> {
			return responses.plan;
		},
		async work(
			_input: WorksInput,
			_route: ModelRoute,
		): Promise<ProductArtifact> {
			return responses.work;
		},
		async audit(
			_input: AuditInput,
			_route: ModelRoute,
		): Promise<AuditVerdict> {
			return responses.audit;
		},
	};
}

export const sampleOrder: WorkOrder = {
	summary: "Build the deterministic contract",
	tasks: ["Produce the artifact body", "Cite one piece of evidence"],
	successConditions: ["The artifact is auditable"],
};

export const sampleArtifact: ProductArtifact = {
	summary: "Deterministic contract",
	body: "One office owns the artifact and its evidence list.",
	evidence: ["fixture receipt"],
};

export const sampleVerdict: AuditVerdict = {
	decision: "pass",
	rationale: "The artifact satisfies the charter",
	findings: [],
};

/** A reusable passing office runner for the operator happy paths. */
export function passingOfficeRunner(): OfficeRunner {
	return staticOfficeRunner({
		plan: sampleOrder,
		work: sampleArtifact,
		audit: sampleVerdict,
	});
}

/**
 * Source text for a runner module which exposes a deterministic
 * `runner` object that completes a one-iteration charter on the first
 * audit. Returns the file path. The source intentionally mirrors the
 * production fixture style so the loader's two export shapes are
 * exercised end-to-end through the operator surface.
 */
export function writePassingRunnerModule(dir: string): string {
	return writeRunnerModule(
		dir,
		`export const runner = {
  plan: async () => ({
    summary: "Build the deterministic contract",
    tasks: ["Produce the artifact body"],
    successConditions: ["The artifact is auditable"],
  }),
  work: async () => ({
    summary: "Deterministic contract",
    body: "One office owns the artifact and its evidence list.",
    evidence: ["fixture receipt"],
  }),
  audit: async () => ({
    decision: "pass",
    rationale: "The artifact satisfies the charter",
    findings: [],
  }),
};`,
	);
}

/**
 * Source text for a runner module whose `audit` always throws. The
 * non-capability failure is the canonical "operator should propagate and
 * never persist a partial receipt" case.
 */
export function writeThrowingAuditRunnerModule(dir: string): string {
	return writeRunnerModule(
		dir,
		`export const runner = {
  plan: async () => ({
    summary: "Plan",
    tasks: ["Produce the body"],
    successConditions: ["The artifact is auditable"],
  }),
  work: async () => ({
    summary: "Artifact",
    body: "Body",
    evidence: [],
  }),
  audit: async () => {
    throw new Error("audit exploded");
  },
};`,
	);
}

/**
 * Capture writes to `process.stdout` / `process.stderr` for the
 * lifetime of the returned `restore` callback. Used to assert CLI
 * output without spawning anything.
 */
export interface CapturedStreams {
	stdout: () => string;
	stderr: () => string;
	restore: () => void;
}

export function captureStdStreams(): CapturedStreams {
	let out = "";
	let err = "";
	const originalOut = process.stdout.write.bind(process.stdout);
	const originalErr = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		out +=
			typeof chunk === "string"
				? chunk
				: Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		err +=
			typeof chunk === "string"
				? chunk
				: Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stderr.write;
	return {
		stdout: () => out,
		stderr: () => err,
		restore: () => {
			process.stdout.write = originalOut;
			process.stderr.write = originalErr;
		},
	};
}
