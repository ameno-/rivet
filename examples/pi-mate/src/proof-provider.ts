/**
 * Config-gated faux proof provider for the live durability harness.
 *
 * When {@link PI_MATE_LIVE_PROOF_FAUX_PROVIDER_ENV} is enabled, the runtime
 * registers the provider defined here under {@link PROOF_PROVIDER_NAME} and
 * serves the proof models from an in-process scripted core built on
 * `@earendil-works/pi-ai`'s public faux API. The provider never opens a
 * network connection and never reads a real credential: the Pi session
 * receives a labeled sentinel API key instead.
 *
 * Claim boundary: this mode proves the durability and control semantics of
 * the Pi Actor — session persistence, event fan-out, reconnect, model
 * switching, steering, abort, compaction, and interrupted-call handling —
 * against a real Rivet Engine. It deliberately does NOT prove the real
 * provider integration (provider auth, streaming transport, or upstream
 * model behavior); that path is exercised only when real credentials are
 * configured. Every report entry records the provider mode so a faux run
 * can never masquerade as the real provider path.
 *
 * Replies are deterministic functions of the prompt text, because the
 * provider instance lives in the runtime process while the harness drives
 * the actor over the network from a separate process:
 *
 * - a prompt whose text contains the word `slow` (case-insensitive)
 *   streams a long reply at {@link SLOW_TOKENS_PER_SECOND}, giving the
 *   steering, abort, and interrupted-call phases a run to act on;
 * - every other prompt receives an immediate short reply that echoes the
 *   model id that served it, so the model-switch phase can assert which
 *   model answered.
 */

import {
	createFauxCore,
	fauxAssistantMessage,
	type Message,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { PiCredentialSource, PiProviderConfig } from "@rivet-dev/pi";
import {
	PI_MATE_LIVE_PROOF_FAUX_PROVIDER_ENV,
	PROOF_MODEL_IDS,
	PROOF_PROVIDER_NAME,
	proofScopedModels,
	readFauxProofProviderEnabled,
} from "./config.ts";

export { PI_MATE_LIVE_PROOF_FAUX_PROVIDER_ENV, readFauxProofProviderEnabled };

/**
 * Sentinel credential handed to the Pi session in faux proof mode. This is
 * a labeled non-secret: it is never a real API key, never grants access to
 * any service, and exists only so the session's credential contract is
 * satisfied without reading an operator secret.
 */
export const PROOF_SENTINEL_API_KEY = "pi-mate-live-proof-faux" as const;

/** Streaming rate for `slow` scripted replies. */
const SLOW_TOKENS_PER_SECOND = 25;

/** Reply body for `slow` prompts. Long enough to keep a run in flight. */
const SLOW_REPLY_TEXT = "proof ".repeat(400);

/** Maximum echo length for immediate replies; keeps responses bounded. */
const IMMEDIATE_REPLY_ECHO_LIMIT = 160;

/**
 * Build the faux proof provider config. Registers every {@link PROOF_MODEL_IDS}
 * model under {@link PROOF_PROVIDER_NAME}. The returned config is handed
 * to `pi({ providers })` verbatim.
 */
export function buildProofProviderConfig(): PiProviderConfig {
	const models = PROOF_MODEL_IDS.map((id) => ({
		id,
		name: id,
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	}));
	const cores = new Map<number, ReturnType<typeof createFauxCore>>();
	const coreFor = (tokensPerSecond: number) => {
		let core = cores.get(tokensPerSecond);
		if (!core) {
			core = createFauxCore({
				api: "mock",
				provider: PROOF_PROVIDER_NAME,
				models,
				tokensPerSecond,
			});
			cores.set(tokensPerSecond, core);
		}
		return core;
	};
	return {
		baseUrl: "http://localhost:0",
		api: "mock",
		models,
		streamSimple: (
			model,
			context: TranscriptContext,
			options?: SimpleStreamOptions,
		) => {
			const prompt = context.messages.findLast(
				(message) => message.role === "user",
			);
			const plan = planProofReply(textOf(prompt), model.id);
			const core = coreFor(plan.slow ? SLOW_TOKENS_PER_SECOND : 0);
			core.setResponses([fauxAssistantMessage(plan.text)]);
			return core.streamSimple(model, context, options);
		},
	};
}

/**
 * Plan the deterministic reply for one prompt. Pure and exported so the
 * routing contract is unit-testable without a Pi session: a prompt whose
 * text contains the word `slow` (case-insensitive) streams a long reply
 * slowly; every other prompt receives an immediate reply that echoes the
 * model id which served it.
 */
export function planProofReply(
	text: string,
	modelId: string,
): {
	slow: boolean;
	text: string;
} {
	const slow = /\bslow\b/i.test(text);
	return {
		slow,
		text: slow
			? SLOW_REPLY_TEXT
			: `proof model ${modelId} acknowledges: ${clip(text, IMMEDIATE_REPLY_ECHO_LIMIT)}`,
	};
}

/**
 * Credential source for faux proof mode. Satisfies the Pi session's
 * credential contract with {@link PROOF_SENTINEL_API_KEY} for the proof
 * provider only: a real provider id gets no credential, so the sentinel
 * can never leak into a real provider call. Never reads the environment.
 */
export function buildProofCredentialSource(): PiCredentialSource {
	return {
		list: async () => [
			{ providerId: PROOF_PROVIDER_NAME, type: "api_key" as const },
		],
		read: async (providerId: string) =>
			providerId === PROOF_PROVIDER_NAME
				? { type: "api_key" as const, key: PROOF_SENTINEL_API_KEY }
				: undefined,
		refresh: async (providerId: string) =>
			providerId === PROOF_PROVIDER_NAME
				? { type: "api_key" as const, key: PROOF_SENTINEL_API_KEY }
				: undefined,
	};
}

/** Extract the text of the last user message, mirroring the upstream mock model. */
function textOf(message: Message | undefined): string {
	if (message?.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");
}

/** Clip a string for echo, appending an ellipsis when truncated. */
function clip(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max)}...`;
}

export { proofScopedModels };
