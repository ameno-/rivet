/**
 * Internal harness helpers for the live Pi Mate durability proof.
 *
 * These helpers are shared between:
 *
 * - the operator-driven CLI in {@link ../../scripts/live-proof.ts};
 * - the dry-run vitest suite under `./live-shape.test.ts`, which
 *   asserts the harness shape itself without touching a live Engine.
 *
 * The helpers never touch a running Engine; they only check operator
 * configuration, derive deterministic proof identifiers, and format
 * reports. Side-effectful operations (action calls, event subscription)
 * live in the script, not here, so the harness can be exercised in
 * unit tests.
 */

/** The names of every phase the harness exposes. */
export const LIVE_PROOF_PHASES = [
	"check",
	"seed",
	"verify-key",
	"verify-events",
	"verify-reconnect",
	"verify-model-switch",
	"verify-steering",
	"verify-abort",
	"verify-compaction",
	"verify-unknown-outcome",
	"verify-runtime-restart",
	"all",
] as const;

/** A single phase name. */
export type LiveProofPhase = (typeof LIVE_PROOF_PHASES)[number];

/** Common fields every report entry carries. */
export interface LiveProofEntryBase {
	phase: LiveProofPhase | "all";
	/** Operator-visible outcome: `pass`, `fail`, `skipped`. */
	outcome: "pass" | "fail" | "skipped";
	/** Reason the phase was skipped, when `outcome === "skipped"`. */
	skipReason?: string;
	/** Free-form human-readable notes; never carry secrets. */
	notes?: string[];
	/** ISO-8601 timestamp the phase started at. */
	startedAt: string;
	/** ISO-8601 timestamp the phase ended at. */
	endedAt: string;
	/** Engine endpoint the phase used (redacted to origin only). */
	endpointOrigin?: string;
	/** Actor key the phase targeted. */
	actorKey?: readonly [string, string, string, string];
}

/**
 * Outcome of a single phase. The shape is intentionally narrow so the
 * vitest suite can assert against it without pulling in any Engine.
 */
export interface LiveProofEntry extends LiveProofEntryBase {
	observations?: Record<string, unknown>;
	/** When the phase found a problem, this is a short, log-safe reason. */
	mismatches?: string[];
}

/**
 * Top-level report shape written by `seed` and appended to by every
 * other phase.
 */
export interface LiveProofReport {
	/** Schema version of the report; bumped when the shape changes. */
	schema: 1;
	/** Engine origin this proof run was launched against. */
	endpointOrigin: string;
	/** Namespace used for actor resolution. */
	namespace: string;
	/** First-mate actor key the proof run targeted. */
	actorKey: readonly [string, string, string, string];
	/** Identifier returned by the Engine for the actor under that key. */
	actorId?: string;
	/** Session identifier Pi minted for the actor. */
	sessionId?: string;
	/** Model the actor session opened with. */
	model?: string;
	/** Message count at the time of the seed prompt. */
	messageCount?: number;
	/** First event ids observed during the seed phase. */
	firstEventIds?: readonly unknown[];
	/** Wall-clock start of the seed phase. */
	seedStartedAt?: string;
	/** Wall-clock end of the seed phase. */
	seedEndedAt?: string;
	/** Per-phase entries appended by subsequent phases. */
	phases: LiveProofEntry[];
}

/** Maximum number of event ids the harness records from a single phase. */
export const MAX_OBSERVED_EVENT_IDS = 8;

/** Maximum number of phases the harness stores before truncating older entries. */
export const MAX_REPORT_PHASES = 32;

/**
 * Reason a phase was skipped. Always paired with `outcome: "skipped"`.
 *
 * - `dry_run`: required live environment is missing.
 * - `unsupported_endpoint`: endpoint format or host is not allowed by the harness.
 * - `missing_credentials`: the model API key env var is unset or empty.
 * - `unmet_dependencies`: previous phase did not produce the required artifact.
 * - `manual_phase`: phase must be driven by the operator (e.g. runtime restart).
 */
export type LiveProofSkipReason =
	| "dry_run"
	| "unsupported_endpoint"
	| "missing_credentials"
	| "unmet_dependencies"
	| "manual_phase";

/** Environment variables the harness inspects. */
export const LIVE_PROOF_ENV = {
	endpoint: "RIVET_ENDPOINT",
	namespace: "RIVET_NAMESPACE",
	token: "RIVET_TOKEN",
	ownerScope: "PI_MATE_OWNER_SCOPE",
	projectId: "PI_MATE_PROJECT_ID",
	threadId: "PI_MATE_THREAD_ID",
	model: "PI_MATE_MODEL",
	scopedModels: "PI_MATE_SCOPED_MODELS",
	apiKeyEnvVars: "PI_MATE_API_KEY_ENV_VARS",
	allowRuntimeRestart: "PI_MATE_LIVE_PROOF_ALLOW_RUNTIME_RESTART",
	reportPath: "PI_MATE_LIVE_PROOF_REPORT",
	// Mirrors PI_MATE_LIVE_PROOF_FAUX_PROVIDER_ENV in src/config.ts. Duplicated
	// by design: this module deliberately avoids importing the source config
	// so the dry-run suite never pulls in @rivet-dev/pi or the sandbox adapter.
	fauxProvider: "PI_MATE_LIVE_PROOF_FAUX_PROVIDER",
} as const;

/** Which provider path a proof run exercises. Recorded in every entry. */
export type LiveProofProviderMode = "faux" | "real";

/** Identifier of the actor under proof. Stable across phases of a single run. */
export interface LiveProofActorIdentity {
	key: readonly [string, string, string, string];
	ownerScope: string;
	projectId: string;
	threadId: string;
}

/**
 * Validate the harness configuration. Returns a structured result that
 * says which prereqs are satisfied and which are not. Never throws; the
 * caller decides what to do with the result.
 */
export interface LiveProofPrereq {
	ok: boolean;
	/** Which provider path this run exercises: faux proof provider or real credentials. */
	providerMode: LiveProofProviderMode;
	endpointOrigin?: string;
	endpointRaw?: string;
	namespace?: string;
	ownerScope?: string;
	projectId?: string;
	model?: string;
	scopedModels?: readonly string[];
	apiKeyEnvVars?: readonly string[];
	skipReason?: LiveProofSkipReason;
	missing: readonly string[];
}

/**
 * Read the harness prerequisites from `env`. The reporter does not
 * reach out to the Engine: every check here is local. Phase `check`
 * adds the live Engine probe.
 */
export function readLiveProofPrereq(env: NodeJS.ProcessEnv): LiveProofPrereq {
	const missing: string[] = [];
	const fauxProvider = isFauxProofProviderEnabled(env);
	const providerMode: LiveProofProviderMode = fauxProvider ? "faux" : "real";
	const endpointRaw = env[LIVE_PROOF_ENV.endpoint]?.trim();
	if (!endpointRaw) missing.push(LIVE_PROOF_ENV.endpoint);
	const ownerScope = env[LIVE_PROOF_ENV.ownerScope]?.trim();
	if (!ownerScope) missing.push(LIVE_PROOF_ENV.ownerScope);
	const projectId = env[LIVE_PROOF_ENV.projectId]?.trim();
	if (!projectId) missing.push(LIVE_PROOF_ENV.projectId);
	const model = env[LIVE_PROOF_ENV.model]?.trim();
	const scopedRaw = env[LIVE_PROOF_ENV.scopedModels]?.trim();
	const scopedModels = scopedRaw
		? scopedRaw
				.split(",")
				.map((value) => value.trim())
				.filter((value) => value.length > 0)
		: undefined;
	const apiKeyEnvVarsRaw = env[LIVE_PROOF_ENV.apiKeyEnvVars]?.trim();
	const apiKeyEnvVars = apiKeyEnvVarsRaw
		? apiKeyEnvVarsRaw
				.split(",")
				.map((value) => value.trim())
				.filter((value) => value.length > 0)
		: ["PI_MATE_ANTHROPIC_API_KEY"];
	const namespace = env[LIVE_PROOF_ENV.namespace]?.trim() || undefined;

	let endpointOrigin: string | undefined;
	let skipReason: LiveProofSkipReason | undefined;
	if (endpointRaw) {
		try {
			const url = new URL(endpointRaw);
			endpointOrigin = url.origin;
			if (isLoopbackHost(url.hostname)) {
				skipReason = "unsupported_endpoint";
				missing.push("RIVET_ENDPOINT(non-loopback)");
			}
		} catch {
			skipReason = "unsupported_endpoint";
			missing.push("RIVET_ENDPOINT(valid URL)");
		}
	}

	// The env model allowlist only applies to the real provider path. In
	// faux mode the runtime forces the proof models regardless, so these
	// env vars are advisory and never block the run.
	if (
		!fauxProvider &&
		model !== undefined &&
		scopedModels !== undefined &&
		!scopedModels.includes(model)
	) {
		skipReason = "dry_run";
		missing.push("PI_MATE_MODEL in PI_MATE_SCOPED_MODELS");
	}

	// Real credentials are only required on the real provider path. The
	// faux proof provider satisfies the session's credential contract with
	// a labeled sentinel, so no operator secret is needed.
	if (!fauxProvider) {
		for (const envVar of apiKeyEnvVars) {
			if (!env[envVar]?.trim()) {
				missing.push(envVar);
			}
		}
	}

	if (missing.length > 0 && skipReason === undefined) {
		skipReason = "dry_run";
	}

	const ok =
		endpointOrigin !== undefined &&
		skipReason === undefined &&
		missing.length === 0;

	return {
		ok,
		providerMode,
		...(endpointOrigin !== undefined ? { endpointOrigin } : {}),
		...(endpointRaw !== undefined ? { endpointRaw } : {}),
		...(namespace !== undefined ? { namespace } : {}),
		...(ownerScope !== undefined ? { ownerScope } : {}),
		...(projectId !== undefined ? { projectId } : {}),
		...(model !== undefined ? { model } : {}),
		...(scopedModels !== undefined ? { scopedModels } : {}),
		apiKeyEnvVars,
		...(skipReason !== undefined ? { skipReason } : {}),
		missing: Object.freeze(missing),
	};
}

/**
 * Read the faux proof provider gate without importing the source config
 * module. Mirrors `readFauxProofProviderEnabled` in `src/config.ts`.
 */
export function isFauxProofProviderEnabled(env: NodeJS.ProcessEnv): boolean {
	const raw = env[LIVE_PROOF_ENV.fauxProvider];
	if (raw === undefined) return false;
	const trimmed = raw.trim().toLowerCase();
	return trimmed === "1" || trimmed === "true";
}

/**
 * True when the supplied hostname is a loopback address. Mirrors the
 * runtime check in `src/runtime.ts` so the harness enforces the same
 * invariant.
 */
export function isLoopbackHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	if (host === "[::1]" || host === "::1") return true;
	if (host.startsWith("127.")) return true;
	return false;
}

/**
 * Build the first-mate actor key the harness will use. Throws when the
 * owner scope, project id, or thread id is missing; the prereq check is
 * expected to have already ruled out the missing case.
 */
export function proofActorKey(env: NodeJS.ProcessEnv): LiveProofActorIdentity {
	const ownerScope = env[LIVE_PROOF_ENV.ownerScope]?.trim();
	const projectId = env[LIVE_PROOF_ENV.projectId]?.trim();
	if (!ownerScope || !projectId) {
		throw new Error(
			`proofActorKey requires ${LIVE_PROOF_ENV.ownerScope} and ${LIVE_PROOF_ENV.projectId}`,
		);
	}
	// The thread segment is what partitions one conversation from another
	// (ADR-0002). The harness defaults it so a single-phase run does not
	// have to set it, but every phase of one run derives the same key.
	const threadId = env[LIVE_PROOF_ENV.threadId]?.trim() || "live-proof";
	const slugs = toSlugQuad(ownerScope, projectId, threadId);
	return {
		key: ["mate", slugs.owner, slugs.project, slugs.thread] as const,
		ownerScope: slugs.owner,
		projectId: slugs.project,
		threadId: slugs.thread,
	};
}

/**
 * Minimal slug normalization that mirrors `normalizeKeySegment` and
 * `normalizeThreadSegment` in the standalone service. The harness does not
 * import the source module directly because doing so pulls in `@rivet-dev/pi`
 * (which fails on Node <22.19). Any change here must be mirrored in
 * `src/config.ts`, because a mismatch silently splits the Mate across two
 * actors.
 */
function toSlugQuad(
	ownerScope: string,
	projectId: string,
	threadId: string,
): {
	owner: string;
	project: string;
	thread: string;
} {
	return {
		owner: slugify(ownerScope),
		project: slugify(projectId),
		thread: slugifyThread(threadId),
	};
}

function slugify(value: string): string {
	const trimmed = value.trim().toLowerCase();
	const slug = trimmed.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	if (slug.length === 0) {
		throw new Error(
			`harness slug must contain at least one alphanumeric character: ${value}`,
		);
	}
	return slug;
}

/** Mirrors `normalizeThreadSegment`: truncate over-long slugs and disambiguate
 * with an FNV-1a hash of the full slug. */
function slugifyThread(value: string): string {
	const slug = slugify(value);
	if (slug.length <= 63) return slug;
	let hash = 0x811c9dc5;
	for (let index = 0; index < slug.length; index += 1) {
		hash ^= slug.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `${slug.slice(0, 63 - 9)}-${hash.toString(16).padStart(8, "0")}`;
}

/**
 * Redact an endpoint URL to its origin. Never returns user info, paths,
 * or query strings. Falls back to `<invalid>` when the input is not a
 * valid URL.
 */
export function redactEndpoint(
	endpoint: string | undefined,
): string | undefined {
	if (!endpoint) return undefined;
	try {
		return new URL(endpoint).origin;
	} catch {
		return "<invalid>";
	}
}

/**
 * Initialize an empty report object. The `schema` field is the shape
 * version; bump it on breaking changes.
 */
export function newReport(
	prereq: LiveProofPrereq,
	actorKey: readonly [string, string, string, string],
): LiveProofReport {
	if (!prereq.endpointOrigin) {
		throw new Error("newReport requires a resolved endpoint origin");
	}
	const report: LiveProofReport = {
		schema: 1,
		endpointOrigin: prereq.endpointOrigin,
		namespace: prereq.namespace ?? "default",
		actorKey,
		phases: [],
	};
	return report;
}

/**
 * Append a phase entry to a report. Caps the number of stored phases
 * to {@link MAX_REPORT_PHASES} so the report stays bounded across
 * long proof runs.
 */
export function appendPhase(
	report: LiveProofReport,
	entry: LiveProofEntry,
): void {
	report.phases.push(entry);
	if (report.phases.length > MAX_REPORT_PHASES) {
		report.phases.splice(0, report.phases.length - MAX_REPORT_PHASES);
	}
}

/**
 * Resolve the path of the report file. Defaults to the current working
 * directory; the CLI accepts `--report` to override.
 */
export function defaultReportPath(): string {
	return "./live-proof-report.json";
}

/**
 * Compute a small fingerprint of a session for cross-phase equality
 * checks. Never includes message bodies or credentials.
 */
export interface SessionFingerprint {
	sessionId: string;
	model: string;
	messageCount: number;
	isIdle: boolean;
}

export function fingerprintSession(info: {
	sessionId?: string;
	model?: unknown;
	messageCount?: number;
	isIdle?: boolean;
}): SessionFingerprint | undefined {
	if (!info.sessionId) return undefined;
	const model = info.model;
	const provider =
		typeof model === "object" && model !== null && "provider" in model
			? String((model as { provider?: unknown }).provider ?? "")
			: "";
	const id =
		typeof model === "object" && model !== null && "id" in model
			? String((model as { id?: unknown }).id ?? "")
			: "";
	return {
		sessionId: info.sessionId,
		model: `${provider}/${id}`,
		messageCount: info.messageCount ?? 0,
		isIdle: info.isIdle ?? false,
	};
}

/**
 * Compare two session fingerprints for equality. Used by the harness
 * to assert that a phase did not silently mutate the session.
 */
export function fingerprintEquals(
	a: SessionFingerprint,
	b: SessionFingerprint,
): boolean {
	return (
		a.sessionId === b.sessionId &&
		a.model === b.model &&
		a.messageCount === b.messageCount &&
		a.isIdle === b.isIdle
	);
}

/**
 * Identify the first event ids from a stream. The harness stores at
 * most {@link MAX_OBSERVED_EVENT_IDS} ids so reports stay bounded.
 */
export function firstEventIds(events: readonly unknown[]): unknown[] {
	const ids: unknown[] = [];
	for (const event of events) {
		if (event && typeof event === "object") {
			const id = (event as { id?: unknown }).id;
			if (id !== undefined) ids.push(id);
		}
		if (ids.length >= MAX_OBSERVED_EVENT_IDS) break;
	}
	return ids;
}

/**
 * Stable JSON serialization for proof reports. Keeps object key order
 * intact so the harness can be diffed against a prior run.
 */
export function stableStringify(value: unknown): string {
	return JSON.stringify(value, replacer, 2);
}

function replacer(_key: string, value: unknown): unknown {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(
			value as Record<string, unknown>,
		).sort()) {
			out[key] = (value as Record<string, unknown>)[key];
		}
		return out;
	}
	return value;
}

/**
 * Build a deterministic proof run id. Operators pass the same owner
 * scope and project id across all phases of one run; the slug pair
 * forms the fingerprint.
 */
export function proofRunId(identity: LiveProofActorIdentity): string {
	return `${identity.ownerScope}__${identity.projectId}__${identity.threadId}`;
}

/**
 * Plan the phases a single `all` invocation should run. Skips
 * `verify-runtime-restart` unless the operator opted in.
 */
export function planAllPhases(
	env: NodeJS.ProcessEnv,
): readonly LiveProofPhase[] {
	const allowRuntimeRestart =
		env[LIVE_PROOF_ENV.allowRuntimeRestart]?.trim() === "1";
	const all: LiveProofPhase[] = [
		"check",
		"seed",
		"verify-key",
		"verify-events",
		"verify-reconnect",
		"verify-model-switch",
		"verify-steering",
		"verify-abort",
		"verify-compaction",
		"verify-unknown-outcome",
	];
	if (allowRuntimeRestart) all.push("verify-runtime-restart");
	return Object.freeze(all);
}
