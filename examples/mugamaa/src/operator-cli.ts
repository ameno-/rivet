#!/usr/bin/env tsx
/**
 * Operator CLI for Mugamaa v0.2 Phase 4.
 *
 * Usage:
 *
 *   mugamaa run <charter.json> --runner-module <path> [--records-dir <dir>]
 *   mugamaa inspect <case-id> [--records-dir <dir>]
 *
 * The CLI never spawns network processes and never reads credentials or
 * base URLs. The caller supplies the runner module path explicitly; no
 * ambient runner is loaded.
 *
 * Exit codes:
 *
 * - `0` on success.
 * - `1` on usage / validation / IO failure. A concise JSON `{ "error":
 *   "...", "code": "..." }` is written to stderr.
 */

import process from "node:process";
import {
	type InspectOperatorOptions,
	inspectOperator,
	OperatorError,
	type RunOperatorOptions,
	runOperator,
} from "./operator.ts";

interface ParsedArgs {
	command: string;
	positionals: string[];
	options: Record<string, string>;
}

const USAGE = [
	"Usage:",
	"  mugamaa run <charter.json> --runner-module <path> [--records-dir <dir>]",
	"  mugamaa inspect <case-id> [--records-dir <dir>]",
].join("\n");

export const DEFAULT_RECORDS_DIR = ".mugamaa/records";

export async function main(argv: readonly string[]): Promise<number> {
	const parsed = parseArgs(argv);
	if (parsed === null) {
		writeError("usage", USAGE);
		return 1;
	}
	const { command, positionals, options } = parsed;
	try {
		if (command === "run") {
			return await runCommand(positionals, options);
		}
		if (command === "inspect") {
			return await inspectCommand(positionals, options);
		}
		if (command === "help" || command === "--help" || command === "-h") {
			process.stdout.write(`${USAGE}\n`);
			return 0;
		}
		writeError("usage", `Unknown command "${command}"\n${USAGE}`);
		return 1;
	} catch (error) {
		const wrapped = wrapError(error);
		writeError(wrapped.code, wrapped.message);
		return 1;
	}
}

async function runCommand(
	positionals: string[],
	opts: Record<string, string>,
): Promise<number> {
	const charterPath = positionals[0];
	if (charterPath === undefined || charterPath.length === 0) {
		writeError(
			"usage",
			`\`run\` requires a path to the Goal Charter JSON\n${USAGE}`,
		);
		return 1;
	}
	const runnerModulePath = opts["runner-module"];
	if (runnerModulePath === undefined || runnerModulePath.length === 0) {
		writeError(
			"usage",
			`\`run\` requires --runner-module <path>\n${USAGE}`,
		);
		return 1;
	}
	const recordsDir = opts["records-dir"] ?? DEFAULT_RECORDS_DIR;
	const options: RunOperatorOptions = {
		charterPath,
		runnerModulePath,
		recordsDir,
	};
	const summary = await runOperator(options);
	writeJson(summary);
	return 0;
}

async function inspectCommand(
	positionals: string[],
	opts: Record<string, string>,
): Promise<number> {
	const caseId = positionals[0];
	if (caseId === undefined || caseId.length === 0) {
		writeError(
			"usage",
			`\`inspect\` requires a case id argument\n${USAGE}`,
		);
		return 1;
	}
	const recordsDir = opts["records-dir"] ?? DEFAULT_RECORDS_DIR;
	const options: InspectOperatorOptions = { caseId, recordsDir };
	const { summary } = await inspectOperator(options);
	writeJson(summary);
	return 0;
}

/**
 * Parse argv-style arguments. Returns `null` for malformed input so the
 * caller can emit a usage error without throwing.
 *
 * Supports `--key value` and `--key=value` long options. Stops parsing
 * at `--`. The first positional token is the command.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs | null {
	if (argv.length === 0) return null;
	const [command, ...rest] = argv;
	if (command === undefined || command.length === 0) return null;
	const positionals: string[] = [];
	const options: Record<string, string> = {};
	for (let i = 0; i < rest.length; i += 1) {
		const arg = rest[i];
		if (arg === undefined) continue;
		if (arg === "--") {
			positionals.push(...rest.slice(i + 1));
			break;
		}
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			if (eq >= 0) {
				const key = arg.slice(2, eq);
				const value = arg.slice(eq + 1);
				if (key.length === 0 || value.length === 0) return null;
				options[key] = value;
				continue;
			}
			const key = arg.slice(2);
			if (key.length === 0) return null;
			const next = rest[i + 1];
			if (next === undefined || next.startsWith("--")) {
				// Bare flag with no value. The current commands treat any
				// missing value as a usage error, so record empty so the
				// caller can decide.
				options[key] = "";
				continue;
			}
			options[key] = next;
			i += 1;
			continue;
		}
		positionals.push(arg);
	}
	return { command, positionals, options };
}

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeError(code: string, message: string): void {
	process.stderr.write(
		`${JSON.stringify({ error: message, code }, null, 2)}\n`,
	);
}

function wrapError(error: unknown): { code: string; message: string } {
	if (error instanceof OperatorError) {
		return { code: error.code, message: error.message };
	}
	if (error instanceof Error) {
		return { code: "internal_error", message: error.message };
	}
	return { code: "internal_error", message: String(error) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exit(code);
		},
		(error: unknown) => {
			writeError(
				"internal_error",
				error instanceof Error ? error.message : String(error),
			);
			process.exit(1);
		},
	);
}
