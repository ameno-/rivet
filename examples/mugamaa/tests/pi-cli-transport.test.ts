import { describe, expect, it } from "vitest";
import {
	isOfficeTransportError,
	type OfficeTransportError,
	type OfficeTransportRequest,
	type OfficeTransportResponse,
} from "../src/office-transport.ts";
import {
	createPiCliTransport,
	type PiCliTransportOptions,
} from "../src/pi-cli-transport.ts";
import {
	createFakeChild,
	createRecordingSpawn,
} from "./pi-cli-transport.fakes.ts";

const baseRequest: OfficeTransportRequest = {
	provider: "opencode-go",
	model: "grok-4.7",
	thinking: "medium",
	prompt: "produce a work order",
};

function request(
	overrides: Partial<OfficeTransportRequest> = {},
): OfficeTransportRequest {
	return { ...baseRequest, ...overrides };
}

async function failure(
	promise: Promise<OfficeTransportResponse>,
): Promise<OfficeTransportError> {
	try {
		await promise;
		throw new Error("expected request to fail");
	} catch (error) {
		expect(isOfficeTransportError(error)).toBe(true);
		return error as OfficeTransportError;
	}
}

function start(
	options: PiCliTransportOptions = {},
	req: OfficeTransportRequest = baseRequest,
) {
	const recording = createRecordingSpawn();
	const child = createFakeChild();
	recording.pending.push(child);
	const transport = createPiCliTransport({
		...options,
		spawnImpl: recording.spawnImpl,
	});
	const result = transport.request(req);
	return { child, recording, result };
}

describe("createPiCliTransport", () => {
	it("uses an argv array with isolated Pi flags and no shell", async () => {
		const { child, recording, result } = start();
		child.feedStdout('{"summary":"ok"}\n');
		child.closeWith(0);

		await expect(result).resolves.toEqual({
			status: 200,
			body: '{"summary":"ok"}',
		});
		expect(recording.calls).toEqual([
			{
				command: "pi",
				args: [
					"--print",
					"--no-session",
					"--no-tools",
					"--no-extensions",
					"--no-skills",
					"--no-prompt-templates",
					"--no-context-files",
					"--no-approve",
					"--model",
					"opencode-go/grok-4.7",
					"--thinking",
					"medium",
					"--",
					"produce a work order",
				],
				cwd: process.cwd(),
				signal: undefined,
				stdio: ["ignore", "pipe", "pipe"],
			},
		]);
		expect(
			(recording.calls[0] as unknown as { shell?: unknown }).shell,
		).toBeUndefined();
	});

	it("forwards explicit executable, cwd, literal prompt, and direct MiniMax route", async () => {
		const prompt = 'literal $HOME `whoami` "quoted"';
		const { child, recording, result } = start(
			{ executable: "/opt/pi", cwd: "/tmp/mugamaa" },
			request({
				provider: "minimax-direct",
				model: "minimax-m3",
				thinking: "low",
				prompt,
			}),
		);
		child.feedStdout("ok");
		child.closeWith(0);
		await result;

		const call = recording.calls[0];
		expect(call?.command).toBe("/opt/pi");
		expect(call?.cwd).toBe("/tmp/mugamaa");
		expect(call?.args).toContain("minimax-direct/minimax-m3");
		expect(call?.args.at(-1)).toBe(prompt);
		expect(call?.args.slice(-4)).toEqual([
			"--thinking",
			"low",
			"--",
			prompt,
		]);
	});

	it("rejects empty successful output", async () => {
		const { child, result } = start();
		child.feedStdout(" \n\t");
		child.closeWith(0);
		expect((await failure(result)).kind).toBe("reject");
	});

	it.each([
		"quota exceeded",
		"HTTP 429 rate limit",
		"resource_exhausted",
		"token limit reached",
	])("classifies capacity evidence: %s", async (message) => {
		const { child, result } = start();
		child.feedStderr(message);
		child.closeWith(1);
		expect((await failure(result)).kind).toBe("capacity");
	});

	it("does not treat unrelated token text as capacity", async () => {
		const { child, result } = start();
		child.feedStderr("lexer token expected");
		child.closeWith(2);
		const error = await failure(result);
		expect(error.kind).toBe("reject");
		expect(error.message).toContain("exit code 2");
	});

	it("does not classify model stdout capacity language as provider capacity", async () => {
		const { child, result } = start();
		child.feedStdout("The design should handle rate limit failures.");
		child.feedStderr("ordinary command failure");
		child.closeWith(2);
		expect((await failure(result)).kind).toBe("reject");
	});

	it("classifies asynchronous spawn errors without exposing the prompt", async () => {
		const secret = "Bearer SECRET-PROMPT";
		const { child, result } = start({}, request({ prompt: secret }));
		const spawnError = new Error("not found");
		(spawnError as NodeJS.ErrnoException).code = "ENOENT";
		child.errorWith(spawnError);
		const error = await failure(result);
		expect(error.kind).toBe("reject");
		expect(error.message).toContain("ENOENT");
		expect(error.message).not.toContain(secret);
	});

	it("classifies synchronous spawn errors", async () => {
		const transport = createPiCliTransport({
			spawnImpl: () => {
				throw new Error("cannot execute");
			},
		});
		const error = await failure(transport.request(baseRequest));
		expect(error.kind).toBe("reject");
		expect(error.message).toContain("failed to spawn");
	});

	it("does not spawn when the signal is already aborted", async () => {
		const recording = createRecordingSpawn();
		const controller = new AbortController();
		controller.abort();
		const transport = createPiCliTransport({
			spawnImpl: recording.spawnImpl,
		});
		const error = await failure(
			transport.request(request({ signal: controller.signal })),
		);
		expect(error.kind).toBe("reject");
		expect(error.message).toContain("aborted");
		expect(recording.calls).toHaveLength(0);
	});

	it("terminates an active child when aborted", async () => {
		const controller = new AbortController();
		const { child, result } = start(
			{},
			request({ signal: controller.signal }),
		);
		controller.abort();
		expect(child.killSignal()).toBe("SIGTERM");
		const error = await failure(result);
		expect(error.kind).toBe("reject");
		expect(error.message).toContain("aborted");
	});

	it("kills and rejects when either output stream exceeds its byte limit", async () => {
		const { child, result } = start({ maxOutputBytes: 8 });
		child.feedStderr("x".repeat(9));
		expect(child.killSignal()).toBe("SIGTERM");
		child.closeWith(null, "SIGTERM");
		const error = await failure(result);
		expect(error.kind).toBe("reject");
		expect(error.message).toContain("configured limit");
	});

	it("performs no transport-level retry", async () => {
		const { child, recording, result } = start();
		child.feedStderr("ordinary failure");
		child.closeWith(1);
		await failure(result);
		expect(recording.calls).toHaveLength(1);
	});
});
