import {
	type ChildProcess,
	type StdioOptions,
	spawn,
} from "node:child_process";
import type {
	OfficeTransport,
	OfficeTransportError,
	OfficeTransportRequest,
	OfficeTransportResponse,
} from "./office-transport.ts";
import type { ThinkingLevel } from "./types.ts";

/**
 * Spawn signature compatible with `node:child_process.spawn`. The
 * interface is the narrowest subset we need: tests substitute a
 * fake implementation that records the argv and returns a synthetic
 * child, while production code uses the real `spawn` from
 * `node:child_process`.
 *
 * The `shell` option is intentionally absent from this type: the
 * transport never enables a shell, so a fake that accepts one would
 * widen the surface for no reason. The fake should ignore any
 * attempt to invoke it with a shell string and prefer the argv-array
 * form.
 */
export type SpawnFn = (
	command: string,
	args: readonly string[],
	options: {
		cwd?: string;
		signal?: AbortSignal;
		stdio?: StdioOptions;
	},
) => ChildProcess;

/**
 * Pinned stdio configuration: stdin is ignored so the prompt stays
 * out of band and cannot be intercepted by a sibling process.
 * Exposed as a tuple so the tests can assert against it directly.
 */
export const PI_CLI_STDIO: ["ignore", "pipe", "pipe"] = [
	"ignore",
	"pipe",
	"pipe",
];

/**
 * Output collector abstraction. The transport writes incoming bytes
 * from stdout/stderr through a collector so tests can substitute a
 * fake implementation that drains immediately, while production
 * code buffers up to a configured byte limit. The collector returns
 * the collected bytes (or throws when the configured limit is exceeded).
 */
export interface OutputCollector {
	write(chunk: Buffer | Uint8Array): void;
	finalize(): Buffer;
}

/**
 * Construct an output collector backed by an in-memory buffer with a
 * hard byte cap. When the cap is exceeded the underlying child is
 * killed and the collector raises an {@link OfficeTransportError} of
 * kind `reject` so the live runner can surface the failure without
 * ever silently truncating the model output.
 */
export interface BoundedCollectorOptions {
	maxBytes: number;
	kill(): void;
	onOverflow(error: Error): void;
}

export function createBoundedCollector(
	options: BoundedCollectorOptions,
): OutputCollector {
	const buffer: Buffer[] = [];
	let size = 0;
	return {
		write(chunk: Buffer | Uint8Array): void {
			const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			const nextSize = size + piece.length;
			if (nextSize > options.maxBytes) {
				options.onOverflow(
					new Error(
						`Pi CLI output exceeded ${options.maxBytes} bytes`,
					),
				);
				options.kill();
				return;
			}
			buffer.push(piece);
			size = nextSize;
		},
		finalize(): Buffer {
			return Buffer.concat(buffer, size);
		},
	};
}

/**
 * Options for {@link createPiCliTransport}. All fields are optional;
 * the defaults compose a self-contained Pi CLI call: spawn `pi` from
 * the current working directory with a 16 MiB output cap, no shell,
 * and the prompt injected as the literal `-- <prompt>` argv tail.
 *
 * `executable` overrides the binary name (default: `"pi"`). Tests
 * typically inject a small script that exits with the desired code
 * after printing the desired body.
 *
 * `cwd` overrides the working directory the spawn uses. Defaults to
 * `process.cwd()`; tests typically point at a fixture directory.
 *
 * `maxOutputBytes` overrides the per-stream cap that the bounded
 * collector enforces. Defaults to {@link DEFAULT_MAX_OUTPUT_BYTES}
 * (16 MiB). Lower values are useful in tests; production must leave
 * the default alone.
 *
 * `spawnImpl` overrides the spawn function entirely. Defaults to
 * `node:child_process.spawn`. The injection point exists so the
 * tests can substitute a fake spawn that returns a synthetic
 * ChildProcess without ever executing a real binary.
 */
export interface PiCliTransportOptions {
	executable?: string;
	cwd?: string;
	maxOutputBytes?: number;
	spawnImpl?: SpawnFn;
}

/** Conservative default output cap. Keeps a runaway model in check. */
export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * Construct an {@link OfficeTransport} backed by the installed Pi
 * CLI. Each call spawns one child process whose argv is composed
 * from the request envelope: provider/model, accepted thinking
 * level, and the prompt after a literal `--` separator.
 *
 * The transport is deliberately narrow: it never branches on
 * provider-specific engine logic, never retries, and never inspects
 * credentials. The durable phase owns replay policy and the model
 * call is allowed to run as long as the model needs.
 */
export function createPiCliTransport(
	options: PiCliTransportOptions = {},
): OfficeTransport {
	const executable = options.executable ?? "pi";
	const cwd = options.cwd ?? process.cwd();
	const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	const spawnImpl: SpawnFn = options.spawnImpl ?? defaultSpawn;

	return {
		async request(
			req: OfficeTransportRequest,
		): Promise<OfficeTransportResponse> {
			return runPiCli({
				request: req,
				executable,
				cwd,
				maxOutputBytes,
				spawnImpl,
			});
		},
	};
}

interface RunArgs {
	request: OfficeTransportRequest;
	executable: string;
	cwd: string;
	maxOutputBytes: number;
	spawnImpl: SpawnFn;
}

async function runPiCli(args: RunArgs): Promise<OfficeTransportResponse> {
	const { request, executable, cwd, maxOutputBytes, spawnImpl } = args;
	const argv = buildArgv(request);
	const signal = request.signal;
	if (signal?.aborted) {
		throw reject("Pi CLI call was aborted");
	}

	let child: ChildProcess;
	try {
		child = spawnImpl(executable, argv, {
			cwd,
			signal,
			stdio: PI_CLI_STDIO,
		});
	} catch (error) {
		throw reject(`Pi CLI failed to spawn: ${describeSpawnError(error)}`);
	}

	const stdout = createBoundedCollector({
		maxBytes: maxOutputBytes,
		kill: () => killChild(child),
		onOverflow: (error) => recordOverflow(error),
	});
	const stderr = createBoundedCollector({
		maxBytes: maxOutputBytes,
		kill: () => killChild(child),
		onOverflow: (error) => recordOverflow(error),
	});

	const overflowErrors: Error[] = [];
	function recordOverflow(error: Error): void {
		overflowErrors.push(error);
	}

	if (child.stdout) {
		child.stdout.on("data", (chunk: Buffer | Uint8Array) =>
			stdout.write(chunk),
		);
	}
	if (child.stderr) {
		child.stderr.on("data", (chunk: Buffer | Uint8Array) =>
			stderr.write(chunk),
		);
	}

	const result = await waitForChild(child, signal);

	const stdoutBody = stdout.finalize().toString("utf8");
	const stderrBody = stderr.finalize().toString("utf8");

	if (overflowErrors.length > 0) {
		throw reject(
			`Pi CLI output exceeded the configured limit of ${maxOutputBytes} bytes`,
		);
	}

	if (result.kind === "spawn-error") {
		throw reject(
			`Pi CLI failed to spawn: ${describeSpawnError(result.error)}`,
		);
	}
	if (result.kind === "aborted") {
		throw reject("Pi CLI call was aborted");
	}

	const { code, signal: termSignal } = result;
	if (code === 0 && !termSignal) {
		const trimmed = stdoutBody.trim();
		if (trimmed.length === 0) {
			throw reject("Pi CLI produced empty output");
		}
		return { status: 200, body: trimmed };
	}

	// Pi emits provider and CLI failures on stderr. Never inspect model stdout
	// for capacity phrases: a failed model response may discuss "rate limits"
	// without the provider itself being capacity-exhausted.
	const classification = classifyFailure(stderrBody, code, termSignal);
	if (classification.kind === "capacity") {
		throw {
			kind: "capacity",
			status: 0,
			message: classification.message,
		} satisfies OfficeTransportError;
	}
	throw {
		kind: "reject",
		message: classification.message,
	} satisfies OfficeTransportError;
}

function buildArgv(request: OfficeTransportRequest): readonly string[] {
	const argv: string[] = [
		"--print",
		"--no-session",
		"--no-tools",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-approve",
		"--model",
		`${request.provider}/${request.model}`,
		`--thinking`,
		encodeThinking(request.thinking),
		"--",
		request.prompt,
	];
	return argv;
}

/**
 * Encode the {@link ThinkingLevel} as the corresponding Pi CLI
 * argument. Anything outside the accepted set is rejected here so
 * the transport cannot forward a stray value to the binary.
 */
function encodeThinking(level: ThinkingLevel): string {
	if (level === "low") return "low";
	if (level === "medium") return "medium";
	throw new Error(
		`Pi CLI transport rejected thinking value: ${JSON.stringify(level)}`,
	);
}

interface WaitResult {
	kind: "exit";
	code: number | null;
	signal: NodeJS.Signals | null;
}

interface AbortedResult {
	kind: "aborted";
}

interface SpawnErrorResult {
	kind: "spawn-error";
	error: unknown;
}

type ChildResult = WaitResult | AbortedResult | SpawnErrorResult;

function waitForChild(
	child: ChildProcess,
	signal: AbortSignal | undefined,
): Promise<ChildResult> {
	return new Promise((resolve) => {
		let settled = false;

		const onAbort = (): void => {
			if (settled) return;
			settled = true;
			killChild(child);
			resolve({ kind: "aborted" });
		};

		if (signal) {
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		child.once("error", (error: Error) => {
			if (settled) return;
			settled = true;
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve({ kind: "spawn-error", error });
		});

		child.once("close", (code, termSignal) => {
			if (settled) return;
			settled = true;
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve({ kind: "exit", code, signal: termSignal });
		});
	});
}

function killChild(child: ChildProcess): void {
	if (child.exitCode !== null || child.signalCode !== null) return;
	try {
		child.kill("SIGTERM");
	} catch {
		// Best-effort: the child may already be dead; the close event
		// handler will fire either way.
	}
}

/**
 * Tokens that identify a quota / rate-limit / capacity /
 * token-exhaustion signal. Lowercased once per call so the per-line
 * match stays cheap.
 *
 * Match strings are deliberately narrow so unrelated output containing
 * the substring "rate" or "token" (a noun for "stack trace", etc.) does
 * not falsely classify a generic provider crash as capacity.
 */
const CAPACITY_TOKENS: readonly string[] = [
	"quota exceeded",
	"quota_exceeded",
	"insufficient_quota",
	"insufficient quota",
	"rate limit",
	"rate-limit",
	"rate_limit",
	"rate limited",
	"too many requests",
	"capacity exceeded",
	"resource_exhausted",
	"resource exhausted",
	"token limit",
	"token exhausted",
	"tokens exhausted",
	"out of tokens",
];

function classifyFailure(
	combined: string,
	code: number | null,
	termSignal: NodeJS.Signals | null,
): { kind: "capacity" | "reject"; message: string } {
	const lower = combined.toLowerCase();
	for (const token of CAPACITY_TOKENS) {
		if (lower.includes(token)) {
			return {
				kind: "capacity",
				message: `Pi CLI reported capacity exhaustion: ${token}`,
			};
		}
	}
	const why = describeExit(code, termSignal);
	return {
		kind: "reject",
		message: `Pi CLI exited unsuccessfully (${why})`,
	};
}

function describeExit(
	code: number | null,
	termSignal: NodeJS.Signals | null,
): string {
	if (termSignal) return `signal ${termSignal}`;
	if (code !== null) return `exit code ${code}`;
	return "no exit code";
}

function describeSpawnError(error: unknown): string {
	if (error instanceof Error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code) return `${error.message} (${code})`;
		return error.message;
	}
	return "unknown spawn error";
}

function reject(message: string): OfficeTransportError {
	return { kind: "reject", message };
}

const defaultSpawn: SpawnFn = (command, args, options) =>
	spawn(command, [...args], {
		cwd: options.cwd,
		signal: options.signal,
		stdio: options.stdio ?? PI_CLI_STDIO,
	});
