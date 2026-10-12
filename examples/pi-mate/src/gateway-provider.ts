/**
 * OpenAI-compatible gateway provider for the standalone Pi Mate.
 *
 * Deployments whose model access is a gateway (a LiteLLM or vLLM endpoint
 * fronting several models) have no first-party credential Pi's built-in
 * catalog can use: the catalog's `openai` provider points at the vendor
 * endpoint. This module registers a first-class provider for that endpoint,
 * so the Mate runs against the same gateway the rest of the deployment
 * already uses instead of requiring a per-vendor key.
 *
 * The API key never appears here: the provider config carries only the base
 * URL and the model catalog, and the credential source
 * (`buildCredentialSource`) reads the key from the environment at call time
 * under {@link GATEWAY_PROVIDER_NAME}, exactly like a first-party provider.
 */

import type { PiProviderConfig } from "@rivet-dev/pi";
import { GATEWAY_PROVIDER_NAME, type GatewayProviderConfig } from "./config.ts";

export { GATEWAY_PROVIDER_NAME };

/**
 * Build the provider config handed to `pi({ providers })`.
 *
 * Every gateway model is advertised with the same metadata: gateways
 * normalize the wire protocol, and the per-model fields Pi needs
 * (`contextWindow`, `maxTokens`) are deployment-level facts about the
 * gateway rather than per-model facts about an upstream vendor. Cost is
 * reported as zero because the gateway, not the model, owns billing.
 */
export function buildGatewayProviderConfig(
	gateway: GatewayProviderConfig,
): PiProviderConfig {
	return {
		baseUrl: gateway.baseUrl,
		// The gateway speaks the OpenAI chat-completions wire protocol.
		api: "openai-completions",
		authHeader: true,
		models: gateway.modelIds.map((id) => ({
			id,
			name: id,
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: gateway.contextWindow,
			maxTokens: gateway.maxTokens,
		})),
	};
}
