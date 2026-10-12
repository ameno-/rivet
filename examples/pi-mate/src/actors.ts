/**
 * Standalone Pi Mate registry.
 *
 * Registers a single Pi Actor (`firstMate`) under a stable, four-segment
 * key derived from the integrator-supplied owner, project, and thread
 * ids. The actor uses the native `@rivet-dev/pi` integration, so it
 * inherits:
 *
 * - `prompt` with requestId idempotency and `whenBusy` steering modes,
 *   plus the full namespaced Pi Durable action surface
 *   (`harness.*`, `conversation.*`, `submission.*`);
 * - native event streaming over the actor's `pi.events` watch channel;
 * - SQLite-backed conversation, submission, and task durability owned by
 *   the actor itself under the Engine, so a worker restart resumes
 *   mid-run work without losing or duplicating anything.
 *
 * This module is intentionally Mugamaa-free. It does not import any
 * Mugamaa actor, credential, or namespace, and it does not enable a
 * Centaur `stateVolume`. Credentials are pulled from the environment at
 * call time via {@link buildCredentialSource}. The optional sandbox
 * provider is built from {@link SandboxProviderConfig} via
 * {@link buildSandboxProvider} and passed straight through to the Pi
 * harness; the provider object never lives in actor state.
 */

import {
	createRegistry,
	defineExtension,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { pi } from "@rivet-dev/pi";
import { setup } from "rivetkit";
import { buildBackendInfoTool } from "./backend-info-tool.ts";
import {
	type PiMateConfig,
	loadPiMateConfig,
	PROOF_PROVIDER_NAME,
	redactConfigForLog,
} from "./config.ts";
import { buildCredentialSource } from "./credentials.ts";
import {
	buildGatewayProviderConfig,
	GATEWAY_PROVIDER_NAME,
} from "./gateway-provider.ts";
import {
	buildProofCredentialSource,
	buildProofProviderConfig,
} from "./proof-provider.ts";
import { buildSandboxProvider, PiMateSandboxConfigError } from "./sandbox.ts";

/** The single actor exposed by this registry. */
export const FIRST_MATE_ACTOR_NAME = "firstMate" as const;

/**
 * Provider-to-env-var mapping for the credentials source. The provider id
 * is the prefix Pi assigns to its models; the env var name is the secret
 * location. Each entry is operator-supplied; nothing here is a literal
 * secret.
 */
const DEFAULT_PROVIDER_ENV_VARS: Record<string, string> = {
	anthropic: "PI_MATE_ANTHROPIC_API_KEY",
	openai: "PI_MATE_OPENAI_API_KEY",
	google: "PI_MATE_GOOGLE_API_KEY",
};

/**
 * Build the credentials source from the configured env var names.
 *
 * The first element of `config.apiKeyEnvVars` is treated as the canonical
 * default; any subsequent names are accepted as additional providers.
 * This is a placeholder for the production mapping (which the operator
 * maintains) and exists so the source can be wired without hard-coding
 * `anthropic`.
 */
function resolveProviderEnvVars(config: PiMateConfig): Record<string, string> {
	if (config.apiKeyEnvVars.length === 0) {
		return { ...DEFAULT_PROVIDER_ENV_VARS };
	}
	const [canonical, ...rest] = config.apiKeyEnvVars;
	if (canonical === undefined) {
		return { ...DEFAULT_PROVIDER_ENV_VARS };
	}
	// Map the canonical name to the well-known anthropic slot, and any
	// additional names to their own slots keyed by the env var name. This
	// keeps the surface predictable while staying configurable.
	const mapping: Record<string, string> = { anthropic: canonical };
	for (const envVar of rest) {
		mapping[envVar.toLowerCase()] = envVar;
	}
	// The gateway provider has its own credential slot, read from the
	// environment at call time like every first-party provider.
	if (config.gateway !== undefined) {
		mapping[GATEWAY_PROVIDER_NAME] = config.gateway.apiKeyEnvVar;
	}
	return mapping;
}

/**
 * Build the custom tools the first-mate actor installs in its Pi Durable
 * harness registry.
 *
 * Single-sourced so the registry wiring and its tests share one
 * definition. Enablement is never decided here: each entry enforces its
 * own fail-closed env gate inside `execute` on every call.
 */
export function buildPiMateCustomTools(
	config: PiMateConfig,
): ToolRegistration[] {
	return [buildBackendInfoTool(config)];
}

/** Name of the Pi Durable extension that carries the Mate's custom tools. */
export const PI_MATE_TOOLS_EXTENSION_NAME = "pi-mate-tools" as const;

/**
 * Build the standalone Pi Mate registry.
 *
 * The registry is independent of Mugamaa's global Supervisor and of the
 * Centaur harness. It owns exactly one Pi Actor definition; an integrator
 * (Centaur, in the prototype) addresses the actor by the key returned
 * from `firstMateActorKey({ ownerScope, projectId, threadId })`.
 */
export function buildPiMateRegistry(config: PiMateConfig = loadPiMateConfig()) {
	const providerEnvVars = resolveProviderEnvVars(config);
	const sandbox = buildSandboxProvider(config.sandbox);

	// Custom providers this deployment registers. Faux proof mode serves the
	// scripted proof models in-process; the gateway serves an OpenAI-compatible
	// endpoint's models. Both are opt-in and recorded in the (redacted) startup
	// config log.
	const providers: Record<
		string,
		ReturnType<typeof buildProofProviderConfig>
	> = {};
	if (config.fauxProofProvider) {
		providers[PROOF_PROVIDER_NAME] = buildProofProviderConfig();
	}
	if (config.gateway !== undefined) {
		providers[GATEWAY_PROVIDER_NAME] = buildGatewayProviderConfig(
			config.gateway,
		);
	}

	// The `pi_mate_backend_info` tool is the one scoped custom tool the
	// Mate exposes. It never touches credentials, file paths, or external
	// services — only the actor's own config.

	// Pi Durable's extension registry: `pi()` refuses to run without one.
	// The `pi_mate_backend_info` tool rides in an installed extension;
	// installed extensions are selected by every conversation by default,
	// and the tool's env-var gate is re-checked inside `execute` on every
	// call, so a mid-session rotation flips the gate without a registry
	// rebuild.
	const harnessRegistry = createRegistry();
	harnessRegistry.install(
		defineExtension({
			name: PI_MATE_TOOLS_EXTENSION_NAME,
			tools: buildPiMateCustomTools(config),
		}),
	);

	// The `credentials` callback receives the actor context; the source it
	// returns is what the Pi runtime queries per generation.
	const firstMate = pi({
		model: config.model,
		scopedModels: [...config.scopedModels],
		...(Object.keys(providers).length > 0 ? { providers } : {}),
		apiKeys: {}, // secrets live behind the credential source, not in actor memory
		credentials: (c) => {
			const owner = c.key[1];
			if (typeof owner === "string") {
				// Log only the public owner scope; never the credential value.
				c.log.info({ msg: "pi mate actor opened", ownerScope: owner });
			}
			return config.fauxProofProvider
				? buildProofCredentialSource()
				: buildCredentialSource(providerEnvVars);
		},
		// The sandbox provider object is built once at registry time and
		// passed through to Pi, which forwards it to the harness. It is
		// never written to actor state, fixtures, or logs.
		...(sandbox !== undefined ? { sandbox } : {}),
		registry: harnessRegistry,
	});

	return setup({
		use: { [FIRST_MATE_ACTOR_NAME]: firstMate },
		// The Engine is an externally managed service in the deployed
		// runtime; this matches `example-mugamaa` and prevents this
		// process from spawning its own Engine.
		startEngine: false,
	});
}

/** Redact the loaded config for safe startup logging. */
export function logSafeConfig(config: PiMateConfig): void {
	// eslint-disable-next-line no-console
	console.log(
		JSON.stringify({
			kind: "pi_mate_config",
			...redactConfigForLog(config),
		}),
	);
}

export { PiMateSandboxConfigError };
