import type {
	OfficeTransport,
	OfficeTransportRequest,
	OfficeTransportResponse,
} from "./office-transport.ts";
import type { ModelProvider } from "./types.ts";

/**
 * Resolves the OpenAI-completions LiteLLM gateway base URL for a provider.
 * Returns `undefined` for unknown providers so the caller can refuse the
 * request without leaking any URL value into source, tests, or records.
 */
export type BaseUrlResolver = (provider: ModelProvider) => string | undefined;

/**
 * Resolves the bearer credential (API key or session token) for a provider.
 * Returns `undefined` when the caller forgot to wire credentials. The live
 * runner never reads, logs, or persists the returned value.
 */
export type CredentialResolver = (
	provider: ModelProvider,
) => string | undefined;

/** Minimal fetch shape. Injected so tests can substitute a fake transport. */
export type FetchLike = (
	url: string,
	init: {
		method: string;
		headers: Record<string, string>;
		body: string;
		signal?: AbortSignal;
	},
) => Promise<{
	status: number;
	text(): Promise<string>;
}>;

/**
 * An OpenAI-compatible chat-completions request body. The live runner never
 * branches on provider-specific fields; everything outside the schema below is
 * provider-specific and out of scope.
 *
 * `reasoning_effort` is the OpenAI-completions standard field for the route's
 * {@link ThinkingLevel} ("low" | "medium"). It is forwarded verbatim so the
 * gateway / model can apply the requested effort without the runner branching
 * on provider-specific reasoning knobs.
 */
interface ChatCompletionsBody {
	model: string;
	messages: { role: "user"; content: string }[];
	temperature?: number;
	reasoning_effort: "low" | "medium";
}

/**
 * Subset of a chat-completions reply that the structured-output module
 * consumes. Other provider-specific fields are intentionally ignored.
 */
interface ChatCompletionsReply {
	choices?: { message?: { content?: string } }[];
}

/**
 * Constructs an OpenAI-completions transport from runtime-only
 * configuration. The transport is intentionally narrow: one request shape,
 * one response shape, no provider-specific engine logic.
 */
export function createLiveTransport(options: {
	baseUrlFor: BaseUrlResolver;
	credentialFor: CredentialResolver;
	fetchImpl?: FetchLike;
}): OfficeTransport {
	const fetchFn = options.fetchImpl ?? defaultFetch;
	return {
		async request(
			req: OfficeTransportRequest,
		): Promise<OfficeTransportResponse> {
			const baseUrl = options.baseUrlFor(req.provider);
			if (!baseUrl) {
				throw {
					kind: "reject",
					message: `No base URL configured for provider ${req.provider}`,
				};
			}
			const credential = options.credentialFor(req.provider);
			if (!credential) {
				throw {
					kind: "reject",
					message: `No credential configured for provider ${req.provider}`,
				};
			}
			const body: ChatCompletionsBody = {
				model: req.model,
				messages: [{ role: "user", content: req.prompt }],
				reasoning_effort: req.thinking,
			};
			const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
			const response = await fetchFn(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${credential}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
				signal: req.signal,
			});
			const text = await response.text();
			if (isCapacityStatus(response.status)) {
				throw {
					kind: "capacity",
					status: response.status,
					message:
						extractMessage(text) ??
						`Capacity status ${response.status}`,
				};
			}
			if (response.status >= 400) {
				throw {
					kind: "reject",
					status: response.status,
					message:
						extractMessage(text) ??
						`Provider error ${response.status}`,
				};
			}
			const reply = parseReply(text);
			const text2 = reply?.choices?.[0]?.message?.content;
			if (typeof text2 !== "string") {
				throw {
					kind: "reject",
					status: response.status,
					message: "Provider reply missing message content",
				};
			}
			return { status: response.status, body: text2 };
		},
	};
}

/**
 * Quota / capacity / token exhaustion signals are the only fallback-eligible
 * class. Anything else (including network errors thrown by fetch and any
 * transport-level timeout such as HTTP 408) is the caller's responsibility to
 * surface; the live runner never falls back. A 408 indicates the provider
 * timed out waiting on the *request*, not that we have exhausted capacity;
 * a retry against another route would not be guaranteed to succeed and
 * could mask a network regression, so it must reject instead.
 */
function isCapacityStatus(status: number): boolean {
	if (status === 429) return true;
	if (status === 402) return true;
	if (status === 503) return true;
	if (status === 529) return true;
	return false;
}

function parseReply(raw: string): ChatCompletionsReply | null {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null) return null;
		return parsed as ChatCompletionsReply;
	} catch {
		return null;
	}
}

function extractMessage(raw: string): string | undefined {
	const parsed = parseReply(raw);
	if (!parsed) return undefined;
	const content = parsed.choices?.[0]?.message?.content;
	if (typeof content === "string" && content.length > 0) return content;
	return undefined;
}

const defaultFetch: FetchLike = async (url, init) => {
	const response = await fetch(url, init);
	return { status: response.status, text: () => response.text() };
};
