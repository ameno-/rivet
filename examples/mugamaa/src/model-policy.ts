import type { ModelPolicy, ModelRoute, OfficeRole } from "./types.ts";

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
