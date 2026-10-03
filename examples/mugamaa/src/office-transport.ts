import type { ModelProvider, ThinkingLevel } from "./types.ts";

/**
 * Public transport request envelope. Credentials and base URLs never appear
 * in source, tests, or records; only injected runtime configuration may
 * produce them.
 *
 * `thinking` carries the route's reasoning-effort level end-to-end so the
 * transport can encode it in the OpenAI-compatible chat-completions request
 * as the standard `reasoning_effort` field. Only the explicit
 * {@link ThinkingLevel} values are forwarded; provider-specific strings
 * never cross this boundary.
 */
export interface OfficeTransportRequest {
	provider: ModelProvider;
	model: string;
	thinking: ThinkingLevel;
	prompt: string;
	signal?: AbortSignal;
}

/**
 * A successful transport reply. `body` is the raw response body that the
 * structured-output parser will validate; no provider-specific parsing
 * happens in this module.
 */
export interface OfficeTransportResponse {
	status: number;
	body: string;
}

/**
 * A transport failure that the live runner maps to either a
 * {@link ModelCapacityError} (fallback-eligible) or a hard reject/escalate
 * signal (non-fallback).
 */
export type OfficeTransportError =
	/** Quota, rate limit, capacity, or token exhaustion. Fallback-eligible. */
	| { kind: "capacity"; status: number; message: string }
	/** Malformed structured output, network error, or arbitrary provider error. */
	| { kind: "reject"; status?: number; message: string };

/**
 * Minimal transport contract. The live runner owns no provider-specific
 * logic; it only consumes a request/response interface that classifies
 * failures into capacity vs reject.
 */
export interface OfficeTransport {
	request(req: OfficeTransportRequest): Promise<OfficeTransportResponse>;
}

export function isOfficeTransportError(
	error: unknown,
): error is OfficeTransportError {
	if (typeof error !== "object" || error === null) return false;
	const kind = (error as { kind?: unknown }).kind;
	return kind === "capacity" || kind === "reject";
}
