/**
 * Local receipt store for completed Mugamaa cases.
 *
 * The operator persists the full CaseState as a single JSON file per case
 * so a later `inspect` command can read it back without re-running the
 * case. The store never holds credentials, base URLs, or external
 * configuration: it is intentionally a plain local file store keyed by
 * case id.
 *
 * Safety properties:
 *
 * - Case ids are validated before they reach the store. The store only
 *   accepts ids that satisfy the strict {@link CASE_ID_PATTERN}; this
 *   prevents path traversal and prevents the id from containing shell
 *   metacharacters that the CLI would otherwise have to escape.
 * - Writes go through a sibling temp file and a single rename. Readers
 *   observe either the previous file or the new file, never a partial
 *   write.
 * - On read the store validates just enough of the JSON to reject
 *   corrupt or partially-flushed files.
 *
 * The store treats the configured directory as the only root it writes
 * to. `path.resolve` plus the strict pattern make absolute path traversal
 * (e.g. `../../etc/passwd`) impossible because such inputs are rejected
 * before the path is constructed.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CaseState } from "./types.ts";

export const CASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class CaseReceiptError extends Error {
	readonly code = "case_receipt";
	constructor(message: string) {
		super(message);
		this.name = "CaseReceiptError";
	}
}

export interface CaseReceiptStoreOptions {
	/**
	 * Absolute or process-relative directory used as the receipt root.
	 * The directory is created lazily on first write.
	 */
	recordsDir: string;
}

export class CaseReceiptStore {
	readonly #recordsDir: string;
	readonly #fileExtension = ".case.json";

	constructor(options: CaseReceiptStoreOptions) {
		this.#recordsDir = resolve(options.recordsDir);
	}

	/**
	 * Returns the absolute path that {@link writeReceipt} would use for
	 * the given case id. Useful for surfacing in CLI output.
	 */
	resolvePath(caseId: string): string {
		const safe = assertSafeCaseId(caseId);
		return join(this.#recordsDir, `${safe}${this.#fileExtension}`);
	}

	async writeReceipt(caseId: string, state: CaseState): Promise<string> {
		const target = this.resolvePath(caseId);
		await mkdir(dirname(target), { recursive: true });
		const tempPath = `${target}.${randomUUID()}.tmp`;
		const payload = JSON.stringify(state, null, 2);
		await writeFile(tempPath, payload, { mode: 0o600 });
		try {
			await rename(tempPath, target);
		} catch (error) {
			// Best-effort cleanup of the orphan temp file if the rename
			// fails. The cleanup is intentionally not awaited-throwing
			// because we want to surface the original rename error.
			try {
				const { unlink } = await import("node:fs/promises");
				await unlink(tempPath);
			} catch {
				// Ignore: the temp file may already be gone.
			}
			throw error;
		}
		return target;
	}

	async readReceipt(caseId: string): Promise<CaseState> {
		const path = this.resolvePath(caseId);
		let raw: string;
		try {
			raw = await readFile(path, "utf8");
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") {
				throw new CaseReceiptError(
					`No receipt found for case id "${caseId}" at ${path}`,
				);
			}
			throw new CaseReceiptError(
				`Failed to read receipt for "${caseId}": ${describeError(error)}`,
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new CaseReceiptError(
				`Receipt for "${caseId}" is not valid JSON: ${describeError(error)}`,
			);
		}
		return assertCaseReceiptShape(caseId, parsed);
	}
}

/**
 * Reject any case id that does not satisfy the strict pattern. This is
 * the single chokepoint that blocks path traversal: the store refuses to
 * compute a filename for an unsafe id, so even absolute callers cannot
 * influence where files are written.
 */
export function assertSafeCaseId(caseId: string): string {
	if (typeof caseId !== "string") {
		throw new CaseReceiptError("Case id must be a string");
	}
	if (!CASE_ID_PATTERN.test(caseId)) {
		throw new CaseReceiptError(
			`Case id "${caseId}" is not safe; must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}`,
		);
	}
	return caseId;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/**
 * Validate the *structural* shape of a parsed receipt. The full CaseState
 * shape is enforced by the case protocol itself; this guard rejects
 * files that cannot possibly be a Mugamaa receipt so a corrupt file does
 * not silently pass the inspect command.
 *
 * The validator accepts any payload that contains a `charter` object
 * with the required fields, a `status` string from the known set, and
 * the records/verdicts arrays the protocol relies on. The case protocol
 * is responsible for never surfacing credentials or external
 * configuration in the first place; this guard does not need to
 * re-check that invariant.
 */
function assertCaseReceiptShape(caseId: string, value: unknown): CaseState {
	if (!isPlainObject(value)) {
		throw new CaseReceiptError(`Receipt for "${caseId}" must be an object`);
	}
	if (!isPlainObject(value.charter)) {
		throw new CaseReceiptError(
			`Receipt for "${caseId}" is missing the charter object`,
		);
	}
	const status = value.status;
	if (typeof status !== "string") {
		throw new CaseReceiptError(
			`Receipt for "${caseId}" is missing the status field`,
		);
	}
	const KNOWN_STATUSES = new Set([
		"pending",
		"planning",
		"working",
		"auditing",
		"revising",
		"completed",
		"blocked",
		"exhausted",
	]);
	if (!KNOWN_STATUSES.has(status)) {
		throw new CaseReceiptError(
			`Receipt for "${caseId}" has unknown status "${status}"`,
		);
	}
	if (!Number.isInteger(value.iteration)) {
		throw new CaseReceiptError(
			`Receipt for "${caseId}" is missing a numeric iteration`,
		);
	}
	if (!Array.isArray(value.verdicts)) {
		throw new CaseReceiptError(
			`Receipt for "${caseId}" is missing the verdicts array`,
		);
	}
	if (!Array.isArray(value.records)) {
		throw new CaseReceiptError(
			`Receipt for "${caseId}" is missing the records array`,
		);
	}
	// The remaining fields (workOrder, artifact) are optional and the
	// cast below is intentionally narrow: the operator only inspects the
	// receipt, the case protocol re-validates if the receipt is ever
	// re-run.
	return value as unknown as CaseState;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}
