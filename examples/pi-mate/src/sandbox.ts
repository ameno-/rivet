/**
 * Sandbox provider boundary for the standalone Pi Mate service.
 *
 * The Pi Actor wires its file and shell tools through a sandbox provider
 * built from {@link SandboxProviderConfig}. The provider itself lives in
 * `@rivet-dev/sandbox-adapter`, which is the native abstraction the Pi
 * integration documents and the surrounding lab prefers. This module is
 * the only place that imports the provider package, so the rest of the
 * service stays decoupled from any specific sandbox runtime.
 *
 * Selection happens once at registry build time. Credentials and
 * endpoints are read at the same moment, never written to actor state,
 * fixtures, logs, or Pi messages. Required configuration is enforced
 * here: a configured provider with a missing API key fails closed rather
 * than silently degrading to a sandbox-less session.
 *
 * Operator policy:
 *
 * - `none` (default) leaves Pi without file or shell tools.
 * - `agentos` routes tools through the agentOS VM actor the surrounding
 *   lab uses. The agentOS actor itself must be present in the registry;
 *   the standard adapter ships a `c.client().agentOS.getOrCreate(...)`
 *   call that the operator's registry composition is expected to satisfy.
 *   Wiring the agentOS actor into this registry is intentionally out of
 *   scope for this issue and is filed against `mugamaa-jen.4`.
 * - `daytona` routes tools through the daytona SDK. The SDK is an
 *   optional peer of `@rivet-dev/sandbox-adapter` and is only loaded when
 *   the operator selects `daytona`.
 * - `e2b` routes tools through the e2b SDK. The provider accepts the API
 *   key directly, so no SDK import is needed at this module's level.
 */

import type { SandboxProvider } from "@rivet-dev/sandbox-adapter";
import { agentOSProvider } from "@rivet-dev/sandbox-adapter/agentos";
import { daytonaProvider } from "@rivet-dev/sandbox-adapter/daytona";
import { e2bProvider } from "@rivet-dev/sandbox-adapter/e2b";
import { createRequire } from "node:module";
import type { Daytona } from "@daytonaio/sdk";
import type { SandboxProviderConfig } from "./config.ts";

export class PiMateSandboxConfigError extends Error {
	readonly code = "pi_mate_sandbox";
	constructor(message: string) {
		super(message);
		this.name = "PiMateSandboxConfigError";
	}
}

/**
 * The default API key env var name the daytona provider reads when the
 * Pi Mate config does not override it.
 */
export const DEFAULT_DAYTONA_API_KEY_ENV_VAR = "DAYTONA_API_KEY";

/**
 * The default API key env var name the e2b provider reads when the Pi
 * Mate config does not override it.
 */
export const DEFAULT_E2B_API_KEY_ENV_VAR = "E2B_API_KEY";

/** The default e2b template id when the Pi Mate config does not override it. */
export const DEFAULT_E2B_TEMPLATE = "base";

/**
 * Build the sandbox provider described by `config`. Returns `undefined`
 * when the configured name is `"none"` so the caller can omit the
 * `sandbox` option entirely.
 *
 * Throws {@link PiMateSandboxConfigError} when the configured provider is
 * missing a required field (for example `agentos` without software
 * entries, or `daytona` without an API key). This is the fail-closed
 * path: a misconfigured deployment never silently downgrades to a less
 * capable provider.
 */
export function buildSandboxProvider(
	config: SandboxProviderConfig,
): SandboxProvider | undefined {
	switch (config.name) {
		case "none":
			return undefined;
		case "agentos":
			return buildAgentOSProvider(config);
		case "daytona":
			return buildDaytonaProvider(config);
		case "e2b":
			return buildE2BProvider(config);
	}
}

function buildAgentOSProvider(config: SandboxProviderConfig): SandboxProvider {
	const software = config.software ?? [];
	if (software.length === 0) {
		throw new PiMateSandboxConfigError(
			"agentOS sandbox requires PI_MATE_SANDBOX_AGENTOS_SOFTWARE to list at least one package URL (e.g. common coreutils)",
		);
	}
	const options: {
		cwd?: string;
		software: { url: string; digest?: string }[];
	} = {
		software: software.map((entry) => {
			if (entry.digest === undefined) return { url: entry.url };
			return { url: entry.url, digest: entry.digest };
		}),
	};
	if (config.cwd !== undefined) options.cwd = config.cwd;
	return agentOSProvider(options);
}

function buildDaytonaProvider(config: SandboxProviderConfig): SandboxProvider {
	const envVar =
		config.daytonaApiKeyEnvVar ?? DEFAULT_DAYTONA_API_KEY_ENV_VAR;
	const apiKey = readEnvVar(envVar);
	if (apiKey === undefined) {
		throw new PiMateSandboxConfigError(
			`daytona sandbox requires ${envVar} to be set (no PI_MATE_SANDBOX_DAYTONA_API_KEY_ENV_VAR fallback was supplied)`,
		);
	}
	// The daytona provider reads its API key through a `Daytona` client
	// instance. The SDK is an optional peer of `@rivet-dev/sandbox-adapter`
	// and is not guaranteed to be installed; import it lazily so a
	// deployment that picks a different provider never loads it.
	return daytonaProvider({ client: newDaytonaClient(apiKey) });
}

/**
 * Construct a `Daytona` client carrying the resolved API key. The SDK is
 * loaded with a synchronous `require` so the daytona provider can capture
 * the client in its closure (it is a synchronous factory that returns an
 * object with async methods).
 *
 * The SDK is an optional peer of `@rivet-dev/sandbox-adapter`. Operators
 * who select `daytona` must install `@daytonaio/sdk`; deployments that pick
 * a different provider never load it. When the package is missing,
 * `require` throws synchronously and the error is rewrapped as a
 * {@link PiMateSandboxConfigError} so the runtime fails closed.
 */
interface DaytonaCtor {
	new (config: { apiKey: string }): unknown;
}

interface DaytonaModule {
	Daytona?: DaytonaCtor;
}

function newDaytonaClient(apiKey: string): Daytona {
	const moduleRef = loadDaytonaSdk();
	if (moduleRef.Daytona === undefined) {
		throw new PiMateSandboxConfigError(
			"daytona sandbox selected but @daytonaio/sdk does not export Daytona",
		);
	}
	return new moduleRef.Daytona({ apiKey }) as Daytona;
}

const daytonaRequire = createRequire(import.meta.url);

function loadDaytonaSdk(): DaytonaModule {
	try {
		return daytonaRequire("@daytonaio/sdk") as DaytonaModule;
	} catch (cause) {
		throw new PiMateSandboxConfigError(
			`daytona sandbox selected but @daytonaio/sdk is not installed: ${errorMessage(cause)}`,
		);
	}
}

function buildE2BProvider(config: SandboxProviderConfig): SandboxProvider {
	const envVar = config.e2bApiKeyEnvVar ?? DEFAULT_E2B_API_KEY_ENV_VAR;
	const apiKey = readEnvVar(envVar);
	if (apiKey === undefined) {
		throw new PiMateSandboxConfigError(
			`e2b sandbox requires ${envVar} to be set (no PI_MATE_SANDBOX_E2B_API_KEY_ENV_VAR fallback was supplied)`,
		);
	}
	// The e2b provider accepts the API key in `create.apiKey`, which is the
	// field its constructor types accept without us having to construct the
	// SDK client directly.
	return e2bProvider({
		template: config.e2bTemplate ?? DEFAULT_E2B_TEMPLATE,
		create: { apiKey },
	});
}

/** Read one environment variable; returns undefined when unset or empty. */
function readEnvVar(name: string): string | undefined {
	const value = process.env[name];
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Render an unknown caught value into a non-empty, log-safe description.
 * Never echoes the env var name or any credential.
 */
function errorMessage(cause: unknown): string {
	if (cause instanceof Error && cause.message.length > 0)
		return cause.message;
	return String(cause);
}
