import type {
	ModelPolicy,
	ModelRoute,
	OfficeRole,
	ThinkingLevel,
} from "./types.ts";

const minimaxFallback: ModelRoute = {
	provider: "minimax-direct",
	model: "minimax-m3",
	thinking: "low",
	tier: "fallback",
};

export const DEFAULT_MODEL_POLICY: ModelPolicy = {
	planning: [
		{
			provider: "opencode",
			model: "kimi-k3",
			thinking: "medium",
			tier: "open",
		},
		minimaxFallback,
	],
	works: [
		{
			provider: "codex",
			model: "gpt-5.6-sol",
			thinking: "medium",
			tier: "frontier",
		},
		{
			provider: "copilot",
			model: "claude-opus-4.8",
			thinking: "medium",
			tier: "frontier",
		},
		minimaxFallback,
	],
	audit: {
		primary: [
			{
				provider: "opencode",
				model: "deepseek-v4.1-flash",
				thinking: "medium",
				tier: "open",
			},
			{
				provider: "opencode",
				model: "glm-5.3-flash",
				thinking: "medium",
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
