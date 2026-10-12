/**
 * Runtime-injected credential source for the standalone Pi Mate service.
 *
 * Per the architecture contract, credentials never live in actor state, in
 * fixtures, or in logs. This source reads API keys from the process
 * environment at the moment {@link read} is called; the value is held only
 * for the duration of the call, never persisted, and is not echoed by the
 * logger when an error occurs.
 */

import type { PiProviderCredential, PiCredentialSource } from "@rivet-dev/pi";

/** Identity of the missing provider, safe to log. */
export interface MissingCredential {
	providerId: string;
	reason: "env_var_unset" | "env_var_empty";
}

export class PiMateCredentialError extends Error {
	readonly code = "pi_mate_credential";
	readonly providerId: string;
	constructor(providerId: string, message: string) {
		super(message);
		this.name = "PiMateCredentialError";
		this.providerId = providerId;
	}
}

/**
 * Build the credential source the Pi Mate actor will use.
 *
 * `providerEnvVars` maps a Rivet Pi provider id (the same id a model is
 * prefixed with, e.g. `anthropic`) to the name of the environment variable
 * that holds its API key. The mapping itself is the only thing the source
 * stores; the values are read fresh on each call so the deployed service
 * can pick up rotated secrets without restart.
 */
export function buildCredentialSource(
	providerEnvVars: Record<string, string>,
): PiCredentialSource {
	return {
		list: async () => {
			const entries: { providerId: string; type: "api_key" }[] = [];
			for (const [providerId, envVar] of Object.entries(
				providerEnvVars,
			)) {
				const value = readEnvVar(envVar);
				if (value !== undefined) {
					entries.push({ providerId, type: "api_key" });
				}
			}
			return entries;
		},
		read: async (
			providerId: string,
		): Promise<PiProviderCredential | undefined> => {
			const envVar = providerEnvVars[providerId];
			if (envVar === undefined) {
				// The provider is not configured for this service. The Pi
				// runtime will treat this as "no credential".
				return undefined;
			}
			const value = readEnvVar(envVar);
			if (value === undefined) {
				throw new PiMateCredentialError(
					providerId,
					`provider "${providerId}" has no credential; set ${envVar}`,
				);
			}
			return { type: "api_key", key: value };
		},
		// The service has no subscription refresh path; credentials are static
		// API keys from the operator's secret store. Pi's `modify` contract
		// requires this method; we satisfy it by returning the current
		// credential unchanged, which is correct for keys that don't expire.
		refresh: async (providerId: string) => {
			const envVar = providerEnvVars[providerId];
			if (envVar === undefined) return undefined;
			const value = readEnvVar(envVar);
			if (value === undefined) return undefined;
			return { type: "api_key", key: value };
		},
	};
}

/** Read one environment variable; returns undefined when unset or empty. */
function readEnvVar(name: string): string | undefined {
	const value = process.env[name];
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Describe the credential gap for one provider, without echoing the env var
 * value. Useful for startup logs that confirm readiness without leaking the
 * secret name into the wrong place.
 */
export function describeMissing(envVar: string): MissingCredential {
	return { providerId: envVar, reason: "env_var_unset" };
}
