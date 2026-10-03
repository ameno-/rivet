import type {
	ModelPolicy,
	ModelRoute,
	OfficeRole,
	ThinkingLevel,
} from "./types.ts";

/**
 * Capacity-only direct MiniMax fallback. Always paired with `low` thinking
 * because it is reserved for the cold-start recovery path after every
 * primary route reports quota, rate-limit, or token-exhaustion. The
 * runner never advertises an OpenCode MiniMax route; the verified model
 * catalog for this provider routes `minimax-m3` exclusively through
 * `minimax-direct`.
 */
const minimaxFallback: ModelRoute = {
	provider: "minimax-direct",
	model: "minimax-m3",
	thinking: "low",
	tier: "fallback",
};

/**
 * Verified default policy for Mugamaa v0.2 Phase 1.
 *
 * Every route resolves to either an OpenCode-go fronted model or the
 * direct MiniMax fallback. The Codex, OpenAI Codex, and Copilot
 * providers and every model whose id begins with `gpt-` are explicitly
 * absent: the legacy entries remain on the {@link ModelProvider} union
 * for adapter extensibility only. The regression test
 * `default policy contains no Codex or GPT route` enforces this
 * invariant at the source level.
 */
export const DEFAULT_MODEL_POLICY: ModelPolicy = {
	planning: [
		{
			provider: "opencode-go",
			model: "kimi-k3",
			thinking: "medium",
			tier: "open",
		},
		minimaxFallback,
	],
	works: [
		{
			provider: "opencode-go",
			model: "grok-4.7",
			thinking: "medium",
			tier: "open",
		},
		minimaxFallback,
	],
	audit: {
		primary: [
			{
				provider: "opencode-go",
				model: "glm-5.3-flash",
				thinking: "medium",
				tier: "open",
			},
			{
				provider: "opencode-go",
				model: "grok-4.7",
				thinking: "low",
				tier: "open",
			},
		],
		fallback: [minimaxFallback],
	},
};

export class ModelCapacityError extends Error {
	readonly code = "model_capacity";

	constructor(message: string) {
		super(message);
		this.name = "ModelCapacityError";
	}
}

export function isModelCapacityError(
	error: unknown,
): error is ModelCapacityError {
	return error instanceof ModelCapacityError;
}

export function routesFor(
	policy: ModelPolicy,
	role: Exclude<OfficeRole, "audit">,
): readonly ModelRoute[] {
	return policy[role];
}

/**
 * Runtime guard for the route's thinking level. The TypeScript
 * {@link ThinkingLevel} union is intentionally narrow ("low" | "medium"),
 * but a route can be constructed at runtime with any string (cast, JSON
 * round-trip, manual wiring) so the live runner must validate the value
 * before it reaches the transport. This guard never silently clamps:
 * values outside the accepted set raise an error so misconfiguration is
 * surfaced immediately rather than masked by a default.
 */
export function assertAcceptedThinking(value: unknown): ThinkingLevel {
	if (value === "low" || value === "medium") return value;
	throw new Error(
		`Office runner rejected thinking value: expected "low" or "medium", received ${describeValue(value)}`,
	);
}

function describeValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (value === undefined) return "undefined";
	if (value === null) return "null";
	return typeof value;
}
