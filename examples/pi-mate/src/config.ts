/**
 * Stable first-mate actor key derivation and namespace policy.
 *
 * ADR-0002 (`docs/decisions/adr-0002-per-thread-pi-session-isolation.md`)
 * fixes the key shape to a four-segment tuple:
 *
 *     ["mate", ownerScope, projectId, threadSegment]
 *
 * ADR-0001 originally fixed a three-segment key and treated the Slack thread
 * as pure delivery context. That shape gave every thread in a project the same
 * actor and therefore the same Pi session: concurrent threads interleaved into
 * one transcript and a compaction in one thread rewrote the other's history.
 * The Pi runtime offers no finer boundary — one `AgentSession` per actor, a
 * single-row session table, and a `navigateTree` that moves one shared head
 * pointer — so the actor key is the only available partition. See ADR-0002 for
 * the measured evidence.
 *
 * The owner, project, and thread identifiers are opaque, normalized values
 * supplied by the upstream integrator (Centaur, for the prototype).
 *
 * The Rivet namespace is owned by the standard `RIVET_NAMESPACE` env var,
 * keeping the service indistinguishable from any other Rivet runtime. The
 * Mate is expected to be deployed with a namespace distinct from
 * Mugamaa's; that distinction is operator policy, not service policy.
 */

/** Reserved first segment of every first-mate actor key. */
export const MATE_KEY_NAMESPACE = "mate" as const;

/** Maximum length of one key segment. */
export const KEY_SEGMENT_MAX_LENGTH = 63;

/** Characters reserved for the thread hash suffix plus its separator. */
const THREAD_HASH_SUFFIX_LENGTH = 9;

/** Default Rivet namespace the service documents for operators. */
export const DEFAULT_PI_MATE_NAMESPACE = "pi-mate" as const;

/** Environment variable name that overrides the default namespace. */
export const PI_MATE_NAMESPACE_ENV = "PI_MATE_NAMESPACE" as const;

/**
 * Identifier rules for the owner and project segments. Keeping these strict
 * is what makes the key derivable and stable across the public surface; an
 * integrator that needs to carry richer identity should encode it into a
 * deterministic slug before calling {@link firstMateActorKey}.
 */
export const KEY_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9-_]{0,62}$/;

export class FirstMateKeyError extends Error {
	readonly code = "first_mate_key";
	constructor(message: string) {
		super(message);
		this.name = "FirstMateKeyError";
	}
}

/**
 * Normalize a raw identifier to a slug: lowercase, trim, and collapse runs of
 * non-alphanumeric characters to a single hyphen. Throws on empty input or on
 * a value with no alphanumeric characters. Does NOT enforce the length limit —
 * callers that can accept a truncated segment (the thread segment) apply it
 * themselves.
 */
function slugifyKeySegment(value: string): string {
	const trimmed = value.trim().toLowerCase();
	if (trimmed.length === 0) {
		throw new FirstMateKeyError("first-mate key segment must not be empty");
	}
	const slug = trimmed.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	if (slug.length === 0) {
		throw new FirstMateKeyError(
			`first-mate key segment "${value}" contains no alphanumeric characters`,
		);
	}
	return slug;
}

/**
 * Normalize an opaque owner or project identifier to a deterministic slug.
 * Enforces the full slug rule, including the 63-character limit, because an
 * over-long owner or project slug is a deployment misconfiguration rather than
 * something to truncate silently.
 */
export function normalizeKeySegment(value: string): string {
	const slug = slugifyKeySegment(value);
	if (!KEY_SEGMENT_PATTERN.test(slug)) {
		throw new FirstMateKeyError(
			`first-mate key segment "${slug}" must match ${KEY_SEGMENT_PATTERN}`,
		);
	}
	return slug;
}

/** FNV-1a 32-bit hash, rendered as 8 lowercase hex characters. Used only to
 * keep a truncated key segment unique; it is not a security primitive. */
export function shortHash(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/**
 * Normalize a Slack-style thread reference to a key segment.
 *
 * Thread references are normalized (lowercased, non-alphanumeric runs collapsed
 * to a single hyphen) exactly like the other segments. When the result would
 * exceed the 63-character limit it is truncated and suffixed with a short hash
 * of the full slug, so two long thread references never collide on the
 * truncation boundary.
 */
export function normalizeThreadSegment(value: string): string {
	const slug = slugifyKeySegment(value);
	if (slug.length <= KEY_SEGMENT_MAX_LENGTH) return slug;
	const head = slug.slice(
		0,
		KEY_SEGMENT_MAX_LENGTH - THREAD_HASH_SUFFIX_LENGTH,
	);
	return `${head}-${shortHash(slug)}`;
}

/**
 * Build the stable actor key tuple for one first-mate scope.
 *
 * The thread segment is what partitions conversations: two Slack threads in the
 * same owner/project scope address two different Mate actors, and therefore two
 * different Pi sessions. Omitting it is an error rather than a default, because
 * a silent fallback to a shared actor is exactly the defect ADR-0002 fixes.
 */
export function firstMateActorKey(input: {
	ownerScope: string;
	projectId: string;
	threadId: string;
}): readonly [string, string, string, string] {
	const owner = normalizeKeySegment(input.ownerScope);
	const project = normalizeKeySegment(input.projectId);
	const thread = normalizeThreadSegment(input.threadId);
	return [MATE_KEY_NAMESPACE, owner, project, thread] as const;
}

/** Resolve the documented namespace for this service. Reads {@link PI_MATE_NAMESPACE_ENV}. */
export function resolveNamespace(): string {
	const value = process.env[PI_MATE_NAMESPACE_ENV]?.trim();
	return value && value.length > 0 ? value : DEFAULT_PI_MATE_NAMESPACE;
}

export class PiMateConfigError extends Error {
	readonly code = "pi_mate_config";
	constructor(message: string) {
		super(message);
		this.name = "PiMateConfigError";
	}
}

/**
 * The runtime configuration the standalone service reads from the
 * environment. Every value is a placeholder; no real credential or bearer
 * token is ever loaded from a file or a fixed default. The Rivet
 * namespace is sourced separately by the standard `RIVET_NAMESPACE` env
 * var and intentionally not duplicated here.
 */
export interface PiMateConfig {
	/** The model the first-mate session opens with, as `provider/modelId`. */
	model: string;
	/** Optional extra models the first-mate may switch to at runtime. */
	scopedModels: readonly string[];
	/** Environment variable names whose values hold model API keys. */
	apiKeyEnvVars: readonly string[];
	/**
	 * Whether the faux proof provider is active. When true, the service
	 * serves the proof models from the in-process `proof` provider with a
	 * sentinel credential and never reads a real API key.
	 */
	fauxProofProvider: boolean;
	/**
	 * OpenAI-compatible gateway provider, when configured. The provider is
	 * registered under {@link GATEWAY_PROVIDER_NAME} and its credential is
	 * read from the environment at call time like every other provider.
	 */
	gateway?: GatewayProviderConfig;
	/** Whether the deployed runtime refuses loopback Engine endpoints. */
	rejectLoopbackEndpoint: boolean;
	/** Optional sandbox provider the Pi session routes file and shell tools through. */
	sandbox: SandboxProviderConfig;
}

/** Sandbox providers the Pi Mate service can wire into `pi({ sandbox })`. */
export type SandboxProviderName = "none" | "agentos" | "daytona" | "e2b";

export const SANDBOX_PROVIDER_NAMES: readonly SandboxProviderName[] = [
	"none",
	"agentos",
	"daytona",
	"e2b",
];

/**
 * One agentOS software package source: a URL plus an optional content
 * digest. URL-only entries are accepted; the agentOS actor verifies the
 * package after download.
 */
export interface SandboxAgentOSSoftwareSource {
	readonly url: string;
	readonly digest?: string;
}

/**
 * Configuration for the sandbox provider the service wires into Pi. The
 * `name` selects which `@rivet-dev/sandbox-adapter` provider is built;
 * `name: "none"` keeps Pi running without file and shell tools. Every
 * provider-specific field is hidden behind the matching `name`.
 */
export interface SandboxProviderConfig {
	readonly name: SandboxProviderName;
	/** Absolute working directory inside the sandbox. Provider-specific default. */
	readonly cwd?: string;
	/** agentOS software package sources. Required when `name === "agentos"`. */
	readonly software?: readonly SandboxAgentOSSoftwareSource[];
	/**
	 * Env var name the daytona provider reads its API key from. Defaults
	 * to `DAYTONA_API_KEY`. Never the value itself.
	 */
	readonly daytonaApiKeyEnvVar?: string;
	/**
	 * Env var name the e2b provider reads its API key from. Defaults to
	 * `E2B_API_KEY`. Never the value itself.
	 */
	readonly e2bApiKeyEnvVar?: string;
	/** E2B template id/name. Defaults to `"base"`. */
	readonly e2bTemplate?: string;
}

export const DEFAULT_PI_MATE_MODEL = "anthropic/claude-sonnet-4-6";
export const DEFAULT_SCOPED_MODELS = [
	"anthropic/claude-sonnet-4-6",
	"anthropic/claude-opus-4-7",
] as const;
export const DEFAULT_API_KEY_ENV_VARS = ["PI_MATE_ANTHROPIC_API_KEY"] as const;
export const PI_MATE_MODEL_ENV = "PI_MATE_MODEL";
export const PI_MATE_SCOPED_MODELS_ENV = "PI_MATE_SCOPED_MODELS";
export const PI_MATE_API_KEY_ENV_VARS_ENV = "PI_MATE_API_KEY_ENV_VARS";

export const DEFAULT_SANDBOX_PROVIDER_NAME: SandboxProviderName = "none";
export const PI_MATE_SANDBOX_PROVIDER_ENV = "PI_MATE_SANDBOX_PROVIDER";
export const PI_MATE_SANDBOX_CWD_ENV = "PI_MATE_SANDBOX_CWD";
export const PI_MATE_SANDBOX_AGENTOS_SOFTWARE_ENV =
	"PI_MATE_SANDBOX_AGENTOS_SOFTWARE";
export const PI_MATE_SANDBOX_DAYTONA_API_KEY_ENV_VAR_ENV =
	"PI_MATE_SANDBOX_DAYTONA_API_KEY_ENV_VAR";
export const PI_MATE_SANDBOX_E2B_API_KEY_ENV_VAR_ENV =
	"PI_MATE_SANDBOX_E2B_API_KEY_ENV_VAR";
export const PI_MATE_SANDBOX_E2B_TEMPLATE_ENV = "PI_MATE_SANDBOX_E2B_TEMPLATE";

/**
 * Environment variable name that feature-gates the `pi_mate_backend_info`
 * custom tool. Off by default; enabling requires this env var to be set to
 * `1` or `true` (case-insensitive). Re-read on every tool call so the
 * deployed service can flip the gate without a restart.
 */
export const PI_MATE_ENABLE_BACKEND_INFO_TOOL_ENV =
	"PI_MATE_ENABLE_BACKEND_INFO_TOOL";

/**
 * Environment variable name that feature-gates the faux proof provider for
 * the live durability harness. Off by default; enabling requires `1` or
 * `true` (case-insensitive). When enabled, the runtime registers the
 * in-process `proof` provider, forces the model allowlist to
 * {@link proofScopedModels}, and hands the session the labeled sentinel
 * credential instead of reading operator secrets. This mode proves the
 * actor's durability and control semantics, never the real provider path.
 */
export const PI_MATE_LIVE_PROOF_FAUX_PROVIDER_ENV =
	"PI_MATE_LIVE_PROOF_FAUX_PROVIDER";

/**
 * OpenAI-compatible gateway provider. Off by default; enabled by setting
 * {@link PI_MATE_GATEWAY_BASE_URL_ENV}.
 *
 * Deployments whose model access is a gateway (a LiteLLM or vLLM endpoint,
 * not a first-party provider API) have no credential Pi's built-in catalog
 * can use: the catalog's `openai` provider points at the vendor endpoint.
 * This block registers a first-class provider for that endpoint so the Mate
 * can run against the same gateway the rest of the deployment already uses,
 * instead of requiring a per-vendor key.
 *
 * The gateway URL and key env var name are configuration; the key value is
 * read from the environment at call time by the credential source, exactly
 * like the first-party providers, so it never lands in actor state or logs.
 */
export const PI_MATE_GATEWAY_BASE_URL_ENV = "PI_MATE_GATEWAY_BASE_URL";
export const PI_MATE_GATEWAY_API_KEY_ENV_VAR_ENV =
	"PI_MATE_GATEWAY_API_KEY_ENV_VAR";
export const PI_MATE_GATEWAY_MODEL_IDS_ENV = "PI_MATE_GATEWAY_MODEL_IDS";
export const PI_MATE_GATEWAY_CONTEXT_WINDOW_ENV =
	"PI_MATE_GATEWAY_CONTEXT_WINDOW";
export const PI_MATE_GATEWAY_MAX_TOKENS_ENV = "PI_MATE_GATEWAY_MAX_TOKENS";

/** Provider id the gateway registers under; models are `gateway/<modelId>`. */
export const GATEWAY_PROVIDER_NAME = "gateway" as const;

/** Default env var the gateway credential is read from. */
export const DEFAULT_GATEWAY_API_KEY_ENV_VAR = "PI_MATE_GATEWAY_API_KEY";

/** Default context window advertised for gateway models. */
export const DEFAULT_GATEWAY_CONTEXT_WINDOW = 128_000;

/** Default output token cap advertised for gateway models. */
export const DEFAULT_GATEWAY_MAX_TOKENS = 8_192;

/** The gateway provider configuration, as loaded from the environment. */
export interface GatewayProviderConfig {
	/** Base URL of the OpenAI-compatible endpoint, including the version
	 * path (for example `https://gw.internal:8449/v1`). Never logged. */
	baseUrl: string;
	/** Name of the env var holding the API key. Only the name is logged. */
	apiKeyEnvVar: string;
	/** Model ids the gateway serves, as `gateway/<modelId>` references. */
	modelIds: readonly string[];
	/** Advertised context window for every gateway model. */
	contextWindow: number;
	/** Advertised output token cap for every gateway model. */
	maxTokens: number;
}

/**
 * Load the gateway provider configuration. Returns `undefined` when
 * {@link PI_MATE_GATEWAY_BASE_URL_ENV} is unset, so a deployment without a
 * gateway is unchanged. Throws {@link PiMateConfigError} when the base URL is
 * set but malformed or no model ids are listed: a half-configured gateway must
 * fail at boot, not serve a model that cannot answer.
 */
export function loadGatewayProviderConfig(
	env: NodeJS.ProcessEnv = process.env,
): GatewayProviderConfig | undefined {
	const baseUrl = (env[PI_MATE_GATEWAY_BASE_URL_ENV] ?? "").trim();
	if (baseUrl.length === 0) return undefined;
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new PiMateConfigError(
			`${PI_MATE_GATEWAY_BASE_URL_ENV} is not a valid URL`,
		);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new PiMateConfigError(
			`${PI_MATE_GATEWAY_BASE_URL_ENV} must be http(s)`,
		);
	}
	const apiKeyEnvVar =
		(env[PI_MATE_GATEWAY_API_KEY_ENV_VAR_ENV] ?? "").trim() ||
		DEFAULT_GATEWAY_API_KEY_ENV_VAR;
	const modelIds = (env[PI_MATE_GATEWAY_MODEL_IDS_ENV] ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	if (modelIds.length === 0) {
		throw new PiMateConfigError(
			`${PI_MATE_GATEWAY_MODEL_IDS_ENV} must list at least one gateway model id`,
		);
	}
	const contextWindow = readPositiveInt(
		env,
		PI_MATE_GATEWAY_CONTEXT_WINDOW_ENV,
		DEFAULT_GATEWAY_CONTEXT_WINDOW,
	);
	const maxTokens = readPositiveInt(
		env,
		PI_MATE_GATEWAY_MAX_TOKENS_ENV,
		DEFAULT_GATEWAY_MAX_TOKENS,
	);
	return { apiKeyEnvVar, baseUrl, contextWindow, maxTokens, modelIds };
}

/** Parse a positive integer env override, falling back to the default. */
function readPositiveInt(
	env: NodeJS.ProcessEnv,
	name: string,
	fallback: number,
): number {
	const raw = (env[name] ?? "").trim();
	if (raw.length === 0) return fallback;
	const value = Number.parseInt(raw, 10);
	if (!Number.isInteger(value) || value <= 0) {
		throw new PiMateConfigError(`${name} must be a positive integer`);
	}
	return value;
}

/** Provider id the faux proof runtime registers under. */
export const PROOF_PROVIDER_NAME = "proof";

/** Model ids the faux proof provider serves; the second is the switch target. */
export const PROOF_MODEL_IDS = ["proof-model", "proof-model-2"] as const;

/**
 * The `<provider>/<model>` allowlist the proof session uses. Stable so the
 * harness, the runtime config, and the docs agree on the switch target.
 */
export function proofScopedModels(): string[] {
	return PROOF_MODEL_IDS.map((id) => `${PROOF_PROVIDER_NAME}/${id}`);
}

/**
 * Read the faux proof provider gate. Returns true only when
 * {@link PI_MATE_LIVE_PROOF_FAUX_PROVIDER_ENV} is set to `1` or `true`
 * (case-insensitive, trimmed). Any other value leaves the service on the
 * real provider path.
 */
export function readFauxProofProviderEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const raw = env[PI_MATE_LIVE_PROOF_FAUX_PROVIDER_ENV];
	if (raw === undefined) return false;
	const trimmed = raw.trim().toLowerCase();
	return trimmed === "1" || trimmed === "true";
}

/**
 * Parse the runtime configuration from environment variables. The function
 * never logs the resolved values, in keeping with the project's invariant
 * that credentials and bearer headers never appear in logs.
 */
export function loadPiMateConfig(
	env: NodeJS.ProcessEnv = process.env,
): PiMateConfig {
	const fauxProofProvider = readFauxProofProviderEnabled(env);
	const gateway = loadGatewayProviderConfig(env);
	// The model allowlist the gateway serves, as `gateway/<modelId>`. Used as
	// the default model list when the gateway is configured and the operator
	// did not pin one, so a gateway deployment boots with zero model config.
	const gatewayScopedModels = gateway
		? gateway.modelIds.map((id) => `${GATEWAY_PROVIDER_NAME}/${id}`)
		: undefined;
	// In faux proof mode the model allowlist is forced to the proof models
	// regardless of PI_MATE_MODEL/PI_MATE_SCOPED_MODELS: the in-process
	// provider serves exactly those models and nothing else.
	const model = fauxProofProvider
		? (proofScopedModels()[0] ??
			`${PROOF_PROVIDER_NAME}/${PROOF_MODEL_IDS[0]}`)
		: (
				env[PI_MATE_MODEL_ENV] ??
				gatewayScopedModels?.[0] ??
				DEFAULT_PI_MATE_MODEL
			).trim();
	if (model.length === 0) {
		throw new PiMateConfigError(`${PI_MATE_MODEL_ENV} must not be empty`);
	}
	const scopedRaw = (env[PI_MATE_SCOPED_MODELS_ENV] ?? "").trim();
	const scopedModels = fauxProofProvider
		? proofScopedModels()
		: scopedRaw.length === 0
			? (gatewayScopedModels ?? [...DEFAULT_SCOPED_MODELS])
			: scopedRaw
					.split(",")
					.map((value) => value.trim())
					.filter((value) => value.length > 0);
	if (scopedModels.length === 0) {
		throw new PiMateConfigError(
			`${PI_MATE_SCOPED_MODELS_ENV} must list at least one model or be unset`,
		);
	}
	if (!scopedModels.includes(model)) {
		throw new PiMateConfigError(
			`${PI_MATE_MODEL_ENV} (${model}) must appear in ${PI_MATE_SCOPED_MODELS_ENV}`,
		);
	}
	const apiKeyRaw = (env[PI_MATE_API_KEY_ENV_VARS_ENV] ?? "").trim();
	const apiKeyEnvVars =
		apiKeyRaw.length === 0
			? [...DEFAULT_API_KEY_ENV_VARS]
			: apiKeyRaw
					.split(",")
					.map((value) => value.trim())
					.filter((value) => value.length > 0);
	if (apiKeyEnvVars.length === 0) {
		throw new PiMateConfigError(
			`${PI_MATE_API_KEY_ENV_VARS_ENV} must list at least one variable name or be unset`,
		);
	}
	return {
		model,
		scopedModels,
		apiKeyEnvVars,
		fauxProofProvider,
		...(gateway ? { gateway } : {}),
		rejectLoopbackEndpoint: true,
		sandbox: loadSandboxProviderConfig(env),
	};
}

/**
 * Parse the sandbox provider configuration from environment variables. The
 * default name is `"none"`, which keeps the Pi session sandbox-less. Each
 * provider-specific field is only meaningful for the matching `name`;
 * mismatched fields are silently ignored so the operator can leave
 * provider-specific defaults in place across rotations.
 */
export function loadSandboxProviderConfig(
	env: NodeJS.ProcessEnv = process.env,
): SandboxProviderConfig {
	const nameRaw = (env[PI_MATE_SANDBOX_PROVIDER_ENV] ?? "").trim();
	const name = parseSandboxProviderName(nameRaw);
	const cwd = readOptionalValue(env, PI_MATE_SANDBOX_CWD_ENV);
	const software = name === "agentos" ? parseAgentOSSoftware(env) : undefined;
	const daytonaApiKeyEnvVar = readOptionalValue(
		env,
		PI_MATE_SANDBOX_DAYTONA_API_KEY_ENV_VAR_ENV,
	);
	const e2bApiKeyEnvVar = readOptionalValue(
		env,
		PI_MATE_SANDBOX_E2B_API_KEY_ENV_VAR_ENV,
	);
	const e2bTemplate = readOptionalValue(
		env,
		PI_MATE_SANDBOX_E2B_TEMPLATE_ENV,
	);
	return {
		name,
		...(cwd !== undefined ? { cwd } : {}),
		...(software !== undefined ? { software } : {}),
		...(daytonaApiKeyEnvVar !== undefined ? { daytonaApiKeyEnvVar } : {}),
		...(e2bApiKeyEnvVar !== undefined ? { e2bApiKeyEnvVar } : {}),
		...(e2bTemplate !== undefined ? { e2bTemplate } : {}),
	};
}

function parseSandboxProviderName(raw: string): SandboxProviderName {
	if (raw.length === 0) return DEFAULT_SANDBOX_PROVIDER_NAME;
	const lowered = raw.toLowerCase();
	if ((SANDBOX_PROVIDER_NAMES as readonly string[]).includes(lowered)) {
		return lowered as SandboxProviderName;
	}
	throw new PiMateConfigError(
		`${PI_MATE_SANDBOX_PROVIDER_ENV} must be one of ${SANDBOX_PROVIDER_NAMES.join(", ")}, received ${JSON.stringify(raw)}`,
	);
}

/**
 * Parse `PI_MATE_SANDBOX_AGENTOS_SOFTWARE` into URL/digest entries. The
 * format is a comma-separated list where each entry is `url` or `url#digest`.
 * Empty entries are dropped silently.
 */
function parseAgentOSSoftware(
	env: NodeJS.ProcessEnv,
): readonly SandboxAgentOSSoftwareSource[] | undefined {
	const raw = (env[PI_MATE_SANDBOX_AGENTOS_SOFTWARE_ENV] ?? "").trim();
	if (raw.length === 0) return undefined;
	const entries: SandboxAgentOSSoftwareSource[] = [];
	for (const piece of raw.split(",")) {
		const trimmed = piece.trim();
		if (trimmed.length === 0) continue;
		const hashIndex = trimmed.lastIndexOf("#");
		if (hashIndex === -1) {
			entries.push({ url: trimmed });
			continue;
		}
		const url = trimmed.slice(0, hashIndex).trim();
		const digest = trimmed.slice(hashIndex + 1).trim();
		if (url.length === 0) {
			throw new PiMateConfigError(
				`${PI_MATE_SANDBOX_AGENTOS_SOFTWARE_ENV} entry missing URL before #: ${JSON.stringify(piece)}`,
			);
		}
		if (digest.length === 0) {
			throw new PiMateConfigError(
				`${PI_MATE_SANDBOX_AGENTOS_SOFTWARE_ENV} entry has empty digest after #: ${JSON.stringify(piece)}`,
			);
		}
		entries.push({ url, digest });
	}
	if (entries.length === 0) return undefined;
	return entries;
}

function readOptionalValue(
	env: NodeJS.ProcessEnv,
	name: string,
): string | undefined {
	const raw = env[name];
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Redact a configured value for logs: never echo full model names that may
 * encode provider information, never echo API key names, never echo tokens.
 * The logger applies this to every config field before emitting.
 */
export function redactConfigForLog(
	config: PiMateConfig,
): Record<string, unknown> {
	return {
		rejectLoopbackEndpoint: config.rejectLoopbackEndpoint,
		// Never a secret, and deliberately visible: startup logs must
		// show when the service runs the faux proof provider so a proof
		// run can never masquerade as the real provider path.
		fauxProofProvider: config.fauxProofProvider,
		// The gateway's base URL is a private endpoint. Only the fact that
		// it is configured and how many models it serves are logged.
		gatewayEnabled: config.gateway !== undefined,
		gatewayModelCount: config.gateway?.modelIds.length ?? 0,
		modelCount: config.scopedModels.length,
		apiKeyEnvVarCount: config.apiKeyEnvVars.length,
		sandbox: redactSandboxProviderConfig(config.sandbox),
	};
}

/**
 * Redact a sandbox provider config for logs. Never echo URLs, digests, or
 * env var names that carry credentials.
 */
export function redactSandboxProviderConfig(
	config: SandboxProviderConfig,
): Record<string, unknown> {
	return {
		name: config.name,
		...(config.cwd !== undefined ? { hasCwd: true } : {}),
		softwareCount: config.software?.length ?? 0,
		hasDaytonaApiKeyEnvVar: config.daytonaApiKeyEnvVar !== undefined,
		hasE2bApiKeyEnvVar: config.e2bApiKeyEnvVar !== undefined,
		hasE2bTemplate: config.e2bTemplate !== undefined,
	};
}
