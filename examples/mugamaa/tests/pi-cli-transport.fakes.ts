/**
 * Test-only support for the Pi CLI transport suite. Provides a
 * `createFakeChild` factory and a `createRecordingSpawn` recorder
 * that the `pi-cli-transport.test.ts` cases consume. The fakes
 * substitute for `node:child_process.spawn` so the tests never
 * execute a real binary and never hit the network.
 */

import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import type { SpawnFn } from "../src/pi-cli-transport.ts";

/**
 * Shape of the child process the transport actually consumes. The
 * transport reads only `stdout.on("data")`, `stderr.on("data")`,
 * `exitCode`, `signalCode`, `kill(signal)`, and listens for `close`
 * and `error` events. We model the fake as an `EventEmitter` that
 * also exposes those fields and is then cast to
 * `ChildProcess` so the `SpawnFn` type agrees with the transport's
 * production code.
 */
export interface FakeChildSurface {
	stdout?: Readable;
	stderr?: Readable;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	kill(signal?: NodeJS.Signals | number): boolean;
}

interface InternalFakeChild extends EventEmitter, FakeChildSurface {
	__killSignal?: NodeJS.Signals | number;
}

/**
 * Build a fake child whose stdout/stderr are readable event emitters
 * and whose `kill` records the signal it was asked to deliver. Tests
 * push bytes via {@link FakeChildHandle.feedStdout} / `feedStderr`
 * and finish via `closeWith(code, signal?)` or `errorWith(error)`.
 */
export interface FakeChildHandle {
	child: InternalFakeChild;
	feedStdout(chunk: string | Buffer): void;
	feedStderr(chunk: string | Buffer): void;
	closeWith(code: number | null, signal?: NodeJS.Signals | null): void;
	errorWith(error: Error): void;
	killSignal(): NodeJS.Signals | number | undefined;
}

export function createFakeChild(): FakeChildHandle {
	const child = new EventEmitter() as InternalFakeChild;
	child.exitCode = null;
	child.signalCode = null;
	child.kill = (signal?: NodeJS.Signals | number): boolean => {
		child.__killSignal = signal ?? "SIGTERM";
		return true;
	};
	const stdout = new EventEmitter() as unknown as Readable;
	const stderr = new EventEmitter() as unknown as Readable;
	child.stdout = stdout;
	child.stderr = stderr;
	return {
		child,
		feedStdout(chunk) {
			stdout.emit(
				"data",
				Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
			);
		},
		feedStderr(chunk) {
			stderr.emit(
				"data",
				Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
			);
		},
		closeWith(code, signal = null) {
			child.exitCode = code;
			child.signalCode = signal;
			child.emit("close", code, signal);
		},
		errorWith(error) {
			child.emit("error", error);
		},
		killSignal() {
			return child.__killSignal;
		},
	};
}

/**
 * Recording `SpawnFn` factory. The fake captures the argv and
 * cwd/signal each call so the tests can assert against them. The
 * caller decides what {@link FakeChildHandle} to return: each test
 * stage queues its own child via `pending.push(...)`.
 */
export interface RecordingSpawn {
	spawnImpl: SpawnFn;
	calls: {
		command: string;
		args: readonly string[];
		cwd?: string;
		signal?: AbortSignal;
		stdio?: readonly ["ignore", "pipe", "pipe"];
	}[];
	pending: FakeChildHandle[];
}

export function createRecordingSpawn(): RecordingSpawn {
	const calls: RecordingSpawn["calls"] = [];
	const pending: FakeChildHandle[] = [];
	const spawnImpl: SpawnFn = ((
		command: string,
		args: readonly string[],
		options: Parameters<SpawnFn>[2],
	) => {
		calls.push({
			command,
			args,
			cwd: options.cwd,
			signal: options.signal,
			stdio: options.stdio as
				| readonly ["ignore", "pipe", "pipe"]
				| undefined,
		});
		const next = pending.shift();
		if (!next) {
			throw new Error(
				"Recording spawn ran out of pending fake children; queue one per call",
			);
		}
		// The transport's `SpawnFn` returns a `ChildProcess`. The fake
		// exposes only the narrow surface the transport actually
		// reads; we cast through `unknown` so the recorder does not
		// have to implement the entire `ChildProcess` interface.
		return next.child as unknown as ReturnType<SpawnFn>;
	}) as SpawnFn;
	return { spawnImpl, calls, pending };
}
