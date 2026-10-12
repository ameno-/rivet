/**
 * Public surface of the standalone Pi Mate service.
 *
 * Re-exports the actor factory, key derivation, credential source, and
 * typed config types so an integrator (Centaur, for the prototype) can
 * import the whole shape from one entry point. The factory takes a
 * {@link PiMateConfig} at call time, matching the "scoped runtime
 * configuration" requirement from the architecture contract.
 */

export {
	DEFAULT_API_KEY_ENV_VARS,
	DEFAULT_GATEWAY_API_KEY_ENV_VAR,
	DEFAULT_GATEWAY_CONTEXT_WINDOW,
	DEFAULT_GATEWAY_MAX_TOKENS,
	DEFAULT_PI_MATE_MODEL,
	DEFAULT_SANDBOX_PROVIDER_NAME,
	DEFAULT_SCOPED_MODELS,
	FirstMateKeyError,
	GATEWAY_PROVIDER_NAME,
	KEY_SEGMENT_MAX_LENGTH,
	KEY_SEGMENT_PATTERN,
	MATE_KEY_NAMESPACE,
	PI_MATE_API_KEY_ENV_VARS_ENV,
	PI_MATE_ENABLE_BACKEND_INFO_TOOL_ENV,
	PI_MATE_GATEWAY_API_KEY_ENV_VAR_ENV,
	PI_MATE_GATEWAY_BASE_URL_ENV,
	PI_MATE_GATEWAY_CONTEXT_WINDOW_ENV,
	PI_MATE_GATEWAY_MAX_TOKENS_ENV,
	PI_MATE_GATEWAY_MODEL_IDS_ENV,
	PI_MATE_MODEL_ENV,
	PI_MATE_SANDBOX_AGENTOS_SOFTWARE_ENV,
	PI_MATE_SANDBOX_CWD_ENV,
	PI_MATE_SANDBOX_DAYTONA_API_KEY_ENV_VAR_ENV,
	PI_MATE_SANDBOX_E2B_API_KEY_ENV_VAR_ENV,
	PI_MATE_SANDBOX_E2B_TEMPLATE_ENV,
	PI_MATE_SANDBOX_PROVIDER_ENV,
	PI_MATE_SCOPED_MODELS_ENV,
	PiMateConfigError,
	SANDBOX_PROVIDER_NAMES,
	firstMateActorKey,
	loadGatewayProviderConfig,
	loadPiMateConfig,
	loadSandboxProviderConfig,
	normalizeKeySegment,
	normalizeThreadSegment,
	redactConfigForLog,
	redactSandboxProviderConfig,
	resolveNamespace,
	shortHash,
	type GatewayProviderConfig,
	type PiMateConfig,
	type SandboxAgentOSSoftwareSource,
	type SandboxProviderConfig,
	type SandboxProviderName,
} from "./config.ts";

export { buildGatewayProviderConfig } from "./gateway-provider.ts";

export {
	PiMateCredentialError,
	buildCredentialSource,
	describeMissing,
	type MissingCredential,
} from "./credentials.ts";

export {
	DEFAULT_DAYTONA_API_KEY_ENV_VAR,
	DEFAULT_E2B_API_KEY_ENV_VAR,
	DEFAULT_E2B_TEMPLATE,
	PiMateSandboxConfigError,
	buildSandboxProvider,
} from "./sandbox.ts";

export {
	BACKEND_INFO_TOOL_MAX_NOTE_LENGTH,
	BACKEND_INFO_TOOL_MAX_RESULT_BYTES,
	BACKEND_INFO_TOOL_MAX_SESSION_ID_LENGTH,
	PI_MATE_BACKEND_INFO_TOOL_NAME,
	buildBackendInfoSnapshot,
	buildBackendInfoTool,
	readBackendInfoToolEnabled,
	type BackendInfoToolDetails,
} from "./backend-info-tool.ts";

export {
	FIRST_MATE_ACTOR_NAME,
	PI_MATE_TOOLS_EXTENSION_NAME,
	buildPiMateCustomTools,
	buildPiMateRegistry,
	logSafeConfig,
} from "./actors.ts";

export {
	PiMateClientErrorImpl,
	type PiMateActorKey,
	type PiMateActorName,
	type PiMateClientError,
	type PiMateRegistry,
} from "./client-types.ts";
