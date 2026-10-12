/**
 * Custom Pi tool: `pi_mate_backend_info`.
 *
 * A read-only, fail-closed tool that returns a bounded, redacted snapshot
 * of the calling Mate actor's own backend context. It is wired into the
 * first-mate actor through a Pi Durable extension installed in the
 * harness registry that `pi()` requires (see `src/actors.ts`), so Pi
 * treats it as a first-class tool that the model can call from any
 * conversation on the actor.
 *
 * The tool exists to validate the capability boundary between the Pi
 * Actor, the upstream integrator (Centaur), and any external services.
 * It therefore:
 *
 *  1. Validates its arguments against a strict TypeBox schema (unknown,
 *     oversized, or malformed args are rejected before any work runs).
 *  2. Is feature-gated by an explicit env var (`PI_MATE_ENABLE_BACKEND_INFO_TOOL`).
 *     Off by default; enabling requires the operator to opt in. The gate
 *     is re-read on every call, so a misconfigured deployment never
 *     silently exposes the tool surface.
 *  3. Only exposes data scoped to the calling actor's own backend
 *     context — never Centaur or Mugamaa state, never host file paths,
 *     never provider/model credentials. It uses the same redaction
 *     helpers (`redactConfigForLog`, `redactSandboxProviderConfig`) that
 *     `src/config.ts` already uses for startup logging.
 *  4. Caps and deterministically truncates its result to a fixed byte
 *     budget (`BACKEND_INFO_TOOL_MAX_RESULT_BYTES`). Truncation is
 *     observable via the `details` payload.
 *  5. Honors Pi's cancellation signal — the call's `abortSignal` is
 *     checked before any work, and the tool returns immediately when the
 *     signal is already aborted.
 *
 * The tool never holds file, shell, or network handles. It never imports
 * the credential source, the sandbox provider, or any external SDK. Its
 * only inputs are the validated `args` argument, the execution API Pi
 * Durable hands it, and the actor's already-loaded `PiMateConfig`.
 */

import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import {
	PI_MATE_ENABLE_BACKEND_INFO_TOOL_ENV,
	type PiMateConfig,
	redactConfigForLog,
	redactSandboxProviderConfig,
} from "./config.ts";

/**
 * Env var read to decide whether the tool is enabled for the current
 * process. Re-exported under the tool-specific alias so tests and the
 * registry can reference a single source of truth without importing
 * `config.ts` directly.
 */
export {
	PI_MATE_ENABLE_BACKEND_INFO_TOOL_ENV as PI_MATE_BACKEND_INFO_TOOL_ENV,
};

/**
 * Maximum byte length of the JSON-encoded tool result the model receives.
 * The cap is enforced by {@link buildBackendInfoSnapshot} deterministically;
 * any payload larger than the cap is truncated to fit and the
 * `truncated` flag is set on the returned details.
 */
export const BACKEND_INFO_TOOL_MAX_RESULT_BYTES = 4_096;

/** Maximum length of the optional `note` argument. */
export const BACKEND_INFO_TOOL_MAX_NOTE_LENGTH = 64;

/**
 * Maximum length of the `sessionId` echoed into the snapshot. Pi session
 * ids are short and stable; the cap is a defense-in-depth bound for any
 * session id implementation that grows with transcript length.
 */
export const BACKEND_INFO_TOOL_MAX_SESSION_ID_LENGTH = 128;

/** Stable tool name. The model uses this string to call the tool. */
export const PI_MATE_BACKEND_INFO_TOOL_NAME = "pi_mate_backend_info" as const;

/**
 * TypeBox schema for the tool's input. Strict — additional properties
 * are rejected, the optional `note` is length-capped, and the body is
 * bounded so a malformed call is rejected before any work runs.
 *
 * Pi's runtime compiles it once and validates every tool call against it
 * before `execute` runs; a Type Compiler error short-circuits with an
 * `isError: true` tool result, so `execute` only sees validated inputs.
 */
const BackendInfoParams = Type.Object(
	{
		note: Type.Optional(
			Type.String({
				description:
					"Optional short label echoed in the snapshot so an integrator can correlate calls. Limited to 64 characters; non-string or oversized values are rejected.",
				maxLength: BACKEND_INFO_TOOL_MAX_NOTE_LENGTH,
				minLength: 1,
			}),
		),
	},
	{
		additionalProperties: false,
		description:
			"Empty or { note } only. Any additional property is rejected as a malformed call.",
	},
);

/** Static-typed details the tool returns alongside the text content.
 * A type alias (not an interface) so it satisfies pi-durable's
 * `TDetails extends JsonValue` constraint on tool details. */
export type BackendInfoToolDetails = {
	/** Whether the env var gate is currently active for this call. */
	enabled: boolean;
	/** Echoed `note` argument, when supplied and within the cap. */
	note?: string;
	/** Current session id, or undefined when none is available yet. */
	sessionId?: string;
	/** Number of models in the actor's allowlist. Names are redacted. */
	modelAllowlistSize: number;
	/** Name of the configured sandbox provider (`none`, `agentos`, ...). */
	sandboxProviderName: string;
	/** Whether the result text was truncated to fit the byte cap. */
	truncated: boolean;
	/** Byte length of the (possibly truncated) text content. */
	bytes: number;
};

/**
 * Read the env-var gate. Returns true only when the env var is set to
 * `1` or `true` (case-insensitive, trimmed). Any other value (unset,
 * empty, typo, accidental whitespace) leaves the tool disabled.
 *
 * The check is intentionally explicit: operators must opt in, and a
 * forgotten clear leaves the tool off. The same predicate is re-evaluated
 * inside the tool's `execute`, so rotating the env var after registry
 * build still flips the gate.
 */
export function readBackendInfoToolEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const raw = env[PI_MATE_ENABLE_BACKEND_INFO_TOOL_ENV];
	if (raw === undefined) return false;
	const trimmed = raw.trim().toLowerCase();
	return trimmed === "1" || trimmed === "true";
}

/**
 * Build the bounded, redacted snapshot for one tool call.
 *
 * The snapshot deliberately excludes:
 *
 *  - the model id (`config.model`) and the full scoped-model list, which
 *    can encode provider identity; only the allowlist *count* is exposed,
 *    matching what `redactConfigForLog` already returns for startup logs;
 *  - the API key env var names, the agentOS package URLs, and every
 *    other credential-shaped field — `redactConfigForLog` /
 *    `redactSandboxProviderConfig` already enforce that;
 *  - the actor id, the file paths, and the cwd. None are needed to prove
 *    the capability boundary, and exposing them would re-introduce the
 *    very surfaces the parent issue pins down.
 *
 * Truncation is byte-accurate (UTF-8) and deterministic: when the payload
 * would exceed {@link BACKEND_INFO_TOOL_MAX_RESULT_BYTES}, the JSON is
 * sliced to leave room for the `truncated` marker, then the marker is
 * appended. The `details.truncated` flag is always set in lock-step.
 */
export function buildBackendInfoSnapshot(input: {
	config: PiMateConfig;
	enabled: boolean;
	note?: string;
	sessionId?: string;
	now?: Date;
}): {
	text: string;
	details: BackendInfoToolDetails;
	truncated: boolean;
} {
	const configRedacted = redactConfigForLog(input.config);
	const sandboxRedacted = redactSandboxProviderConfig(input.config.sandbox);
	const modelAllowlistSize =
		typeof configRedacted.modelCount === "number"
			? configRedacted.modelCount
			: 0;
	const sandboxProviderName =
		typeof sandboxRedacted.name === "string"
			? sandboxRedacted.name
			: "none";

	const snapshot = {
		kind: "pi_mate_backend_info",
		sessionId: clipString(
			input.sessionId,
			BACKEND_INFO_TOOL_MAX_SESSION_ID_LENGTH,
		),
		modelAllowlistSize,
		sandboxProviderName,
		backendInfoToolEnabled: input.enabled,
		note: clipString(input.note, BACKEND_INFO_TOOL_MAX_NOTE_LENGTH),
		generatedAt: (input.now ?? new Date()).toISOString(),
	};

	let text = JSON.stringify(snapshot);
	let truncated = false;
	const budget = BACKEND_INFO_TOOL_MAX_RESULT_BYTES;
	const marker = `{"truncated":true,"originalBytes":${Buffer.byteLength(text)}}`;
	if (Buffer.byteLength(text) > budget) {
		// Reserve enough bytes for the trailing marker; the cap is
		// small enough that the marker always fits.
		const sliceBytes = Math.max(0, budget - Buffer.byteLength(marker));
		text = `${Buffer.from(text).subarray(0, sliceBytes).toString("utf8")}${marker}`;
		truncated = true;
	}

	const details: BackendInfoToolDetails = {
		enabled: input.enabled,
		modelAllowlistSize,
		sandboxProviderName,
		truncated,
		bytes: Buffer.byteLength(text),
	};
	if (input.note !== undefined)
		details.note = clipString(
			input.note,
			BACKEND_INFO_TOOL_MAX_NOTE_LENGTH,
		);
	if (input.sessionId !== undefined)
		details.sessionId = clipString(
			input.sessionId,
			BACKEND_INFO_TOOL_MAX_SESSION_ID_LENGTH,
		);

	return { text, details, truncated };
}

/** Clip a string to `max` characters. Returns undefined when input is undefined. */
function clipString(
	value: string | undefined,
	max: number,
): string | undefined {
	if (value === undefined) return undefined;
	if (value.length <= max) return value;
	return value.slice(0, max);
}

/**
 * Build the `pi_mate_backend_info` tool registration.
 *
 * The factory always returns the tool object — the gate is enforced
 * inside `execute`, so a registry that has not enabled the tool returns
 * an explicit `isError: true` result instead of silently omitting the
 * tool. That keeps the gate observable from the agent log without
 * compromising the fail-closed contract.
 *
 * The session id in the snapshot is the calling conversation's durable
 * id (`api.conversationId`): in Pi Durable the conversation is the
 * persisted session, so the id is stable across sleeps, restarts, and
 * reconnects.
 */
export function buildBackendInfoTool(
	config: PiMateConfig,
): ToolRegistration<typeof BackendInfoParams, BackendInfoToolDetails> {
	return defineTool({
		name: PI_MATE_BACKEND_INFO_TOOL_NAME,
		description:
			"Return a bounded, redacted snapshot of this Pi Mate actor's own backend context (session id, model allowlist size, sandbox provider, and the tool's own enablement flag). Read-only. Never exposes provider credentials, host environment, host file paths, or any service outside the calling actor.",
		parameters: BackendInfoParams,
		async execute(args, api, context) {
			// Honour the cancellation signal before any work; the runtime
			// passes the call's AbortSignal on the chord context here.
			if (context.abortSignal?.aborted) {
				throw new Error(
					`${PI_MATE_BACKEND_INFO_TOOL_NAME} aborted before execution`,
				);
			}

			// Re-check the env gate inside execute so a registry built with
			// the gate off stays off even if the process environment
			// rotates mid-conversation.
			const enabled = readBackendInfoToolEnabled();
			const sessionId = String(api.conversationId);
			const snapshot = buildBackendInfoSnapshot({
				config,
				enabled,
				note: args.note,
				sessionId,
			});

			if (!enabled) {
				// Fail closed: the model sees an explicit error result, so
				// the gate is observable without ever exposing the snapshot.
				return {
					content: [
						{
							type: "text",
							text:
								`${PI_MATE_BACKEND_INFO_TOOL_NAME} is disabled: set ` +
								`${PI_MATE_ENABLE_BACKEND_INFO_TOOL_ENV}=1 to enable`,
						},
					],
					details: snapshot.details,
					isError: true,
				};
			}

			return {
				content: [{ type: "text", text: snapshot.text }],
				details: snapshot.details,
			};
		},
	});
}
