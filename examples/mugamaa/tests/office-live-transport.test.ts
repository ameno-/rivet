import { describe, expect, it } from "vitest";
import {
	createLiveTransport,
	type FetchLike,
} from "../src/office-live-transport.ts";
import { isOfficeTransportError } from "../src/office-transport.ts";

/**
 * The live transport is intentionally narrow: one request shape, one
 * response shape, no provider-specific engine logic. These tests verify
 * (a) the OpenAI-compatible chat-completions body carries the route's
 * reasoning effort verbatim and (b) HTTP 408 (request timeout) is
 * classified as a hard reject, never as a capacity signal.
 */

interface CapturedCall {
	url: string;
	init: {
		method: string;
		headers: Record<string, string>;
		body: string;
		signal?: AbortSignal;
	};
}

function makeTransport(
	handler: FetchLike,
): ReturnType<typeof createLiveTransport> {
	return createLiveTransport({
		baseUrlFor: () => "https://gateway.test/v1",
		credentialFor: () => "runtime-injected-credential",
		fetchImpl: handler,
	});
}

function captureHandler(
	status: number,
	body: string,
): {
	calls: CapturedCall[];
	fetchImpl: FetchLike;
} {
	const calls: CapturedCall[] = [];
	const fetchImpl: FetchLike = async (_url, init) => {
		calls.push({ url: _url, init });
		return {
			status,
			text: async () => body,
		};
	};
	return { calls, fetchImpl };
}

describe("createLiveTransport", () => {
	it("encodes the route's thinking level as reasoning_effort in the chat-completions body", async () => {
		const reply = JSON.stringify({
			choices: [{ message: { content: "ok" } }],
		});
		const { calls, fetchImpl } = captureHandler(200, reply);
		const transport = makeTransport(fetchImpl);
		await transport.request({
			provider: "opencode-go",
			model: "grok-4.7",
			thinking: "medium",
			prompt: "produce work",
		});
		expect(calls).toHaveLength(1);
		const body = JSON.parse(calls[0]?.init.body ?? "{}") as Record<
			string,
			unknown
		>;
		expect(body.model).toBe("grok-4.7");
		expect(body.reasoning_effort).toBe("medium");
		expect(body.messages).toEqual([
			{ role: "user", content: "produce work" },
		]);
	});

	it("encodes low thinking as low reasoning_effort", async () => {
		const reply = JSON.stringify({
			choices: [{ message: { content: "ok" } }],
		});
		const { calls, fetchImpl } = captureHandler(200, reply);
		const transport = makeTransport(fetchImpl);
		await transport.request({
			provider: "minimax-direct",
			model: "minimax-m3",
			thinking: "low",
			prompt: "fallback prompt",
		});
		const body = JSON.parse(calls[0]?.init.body ?? "{}") as Record<
			string,
			unknown
		>;
		expect(body.reasoning_effort).toBe("low");
	});

	it("classifies HTTP 408 as a hard reject and never as a capacity signal", async () => {
		const { fetchImpl } = captureHandler(
			408,
			JSON.stringify({
				error: { message: "request timed out at gateway" },
			}),
		);
		const transport = makeTransport(fetchImpl);
		let caught: unknown;
		try {
			await transport.request({
				provider: "opencode-go",
				model: "grok-4.7",
				thinking: "medium",
				prompt: "produce work",
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeDefined();
		expect(isOfficeTransportError(caught)).toBe(true);
		if (isOfficeTransportError(caught)) {
			expect(caught.kind).toBe("reject");
			expect(caught.status).toBe(408);
		}
	});

	it("keeps explicit capacity statuses (429, 402, 503, 529) classified as capacity", async () => {
		for (const status of [429, 402, 503, 529]) {
			const { fetchImpl } = captureHandler(
				status,
				JSON.stringify({
					error: { message: `capacity ${status}` },
				}),
			);
			const transport = makeTransport(fetchImpl);
			let caught: unknown;
			try {
				await transport.request({
					provider: "opencode-go",
					model: "grok-4.7",
					thinking: "medium",
					prompt: "produce work",
				});
			} catch (error) {
				caught = error;
			}
			expect(isOfficeTransportError(caught)).toBe(true);
			if (isOfficeTransportError(caught)) {
				expect(caught.kind).toBe("capacity");
				expect(caught.status).toBe(status);
			}
		}
	});
});
