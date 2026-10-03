import { assertAcceptedThinking, ModelCapacityError } from "./model-policy.ts";
import {
	parseAuditVerdict,
	parseProductArtifact,
	parseWorkOrder,
} from "./office-output.ts";
import { auditPrompt, planningPrompt, worksPrompt } from "./office-prompts.ts";
import type {
	AuditInput,
	AuditVerdict,
	ModelProvider,
	ModelRoute,
	OfficeRunner,
	PlanningInput,
	ProductArtifact,
	ThinkingLevel,
	WorkOrder,
	WorksInput,
} from "./types.ts";

/**
 * Structural view of a Pi actor handle. The bridge consumes only the four
 * Mugamaa-relevant Pi actions:
 *
 *   - `setModel` switches the actor's provider and model id.
 *   - `setThinkingLevel` aligns the actor's reasoning effort with the
 *     route's {@link ThinkingLevel}.
 *   - `prompt` runs the actor's chat completion.
 *   - `getLastAssistantText` returns the raw assistant text the strict
 *     parsers consume.
 *
 * The view is intentionally minimal: the bridge never touches Pi auth,
 * models.json, base URLs, sandbox wiring, or credential stores. The
 * registry / application wiring layer owns those concerns and is
 * responsible for binding a `PiContext` to the actor before returning
 * the handle.
 */
export interface PiOfficeHandle {
	setModel(provider: ModelProvider, modelId: string): Promise<void>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	prompt(text: string): Promise<void>;
	getLastAssistantText(): Promise<string | undefined>;
}

/**
 * Resolves a deterministic actor key to a {@link PiOfficeHandle}. The
 * resolver is injected at construction; the bridge never opens clients,
 * reads credentials, or instantiates actors itself.
 */
export type PiOfficeActorResolver = (key: string) => PiOfficeHandle;

/**
 * Classifies an error raised by a Pi actor action. The bridge only maps
 * an error to {@link ModelCapacityError} when the classifier explicitly
 * identifies it as a quota / capacity / token-exhaustion signal.
 *
 * Returning `false` (the default for any classifier that does not
 * recognize the shape) lets the error propagate as a blocking error so
 * the engine's fallback machinery can surface it.
 */
export type PiOfficeErrorClassifier = (error: unknown) => boolean;

/**
 * Options for {@link createPiOfficeRunner}.
 */
export interface PiOfficeRunnerOptions {
	resolveActor: PiOfficeActorResolver;
	/**
	 * Classifier that flags quota / capacity / token-exhaustion errors.
	 * Optional: when omitted, every action error is treated as a
	 * blocking error and propagates without being remapped.
	 */
	classifyCapacity?: PiOfficeErrorClassifier;
}

/**
 * Deterministic actor key for one Mugamaa Office call. The shape
 * matches the bridge's required naming:
 *
 *   - `<case-id>/<iteration>/planning`
 *   - `<case-id>/<iteration>/works`
 *   - `<case-id>/<iteration>/audit/<provider>/<model>`
 *
 * Segments are sanitized so the key remains a single string the
 * underlying runtime can accept while staying reversible byte-for-byte
 * from the original segments.
 */
export type PiOfficeActorKey = string;

export function planningActorKey(
	caseId: string,
	iteration: number,
): PiOfficeActorKey {
	return joinKey([caseId, String(iteration), "planning"]);
}

export function worksActorKey(
	caseId: string,
	iteration: number,
): PiOfficeActorKey {
	return joinKey([caseId, String(iteration), "works"]);
}

export function auditActorKey(
	caseId: string,
	iteration: number,
	route: ModelRoute,
): PiOfficeActorKey {
	return joinKey([
		caseId,
		String(iteration),
		"audit",
		route.provider,
		route.model,
	]);
}

function joinKey(segments: readonly string[]): PiOfficeActorKey {
	return segments.map(sanitizeKeySegment).join("/");
}

/**
 * Reversible, deterministic segment encoder. The default
 * {@link encodeURIComponent} keeps every byte recoverable by the
 * inverse {@link decodeURIComponent} call while eliminating the slash
 * and NUL byte that would otherwise split or truncate the key. The
 * function is pure and has no runtime dependencies; tests exercise the
 * full encode/decode round-trip on each role's segments.
 */
export function sanitizeKeySegment(segment: string): string {
	return encodeURIComponent(segment);
}

export function unsanitizeKeySegment(segment: string): string {
	return decodeURIComponent(segment);
}

/**
 * Bridge between the Mugamaa engine and the Mugamaa-relevant subset of
 * the Pi actor action surface. The bridge owns three responsibilities:
 *
 *   1. Compute a deterministic actor key for the office role and
 *      resolve it through the injected resolver.
 *   2. Drive the four-action sequence (`setModel` → `setThinkingLevel`
 *      → `prompt` → `getLastAssistantText`) once per office call. The
 *      bridge never retries: a Pi "stopReason: 'error'" or empty
 *      assistant text surfaces immediately so the engine can fall back
 *      explicitly when capacity allows, or block the case otherwise.
 *   3. Validate the route's thinking level before touching the handle
 *      and parse the response through the existing strict parsers.
 *
 * The bridge is deliberately agnostic about credentials, base URLs, and
 * Pi session lifecycle: those concerns live in the registry /
 * application wiring layer that constructs the resolver. This module
 * does not import `@rivet-dev/pi`, read `auth.json`, or call
 * `process.env`.
 */
export function createPiOfficeRunner(
	options: PiOfficeRunnerOptions,
): OfficeRunner {
	const resolve = options.resolveActor;
	const classify = options.classifyCapacity ?? (() => false);
	return {
		async plan(
			input: PlanningInput,
			route: ModelRoute,
		): Promise<WorkOrder> {
			const reply = await runOffice({
				input,
				route,
				key: planningActorKey(input.charter.id, input.iteration),
				prompt: planningPrompt(input),
				classify,
				resolve,
			});
			const parsed = parseWorkOrder(reply);
			if (!parsed.ok) rejectStructured(parsed.reason);
			return parsed.value;
		},
		async work(
			input: WorksInput,
			route: ModelRoute,
		): Promise<ProductArtifact> {
			const reply = await runOffice({
				input,
				route,
				key: worksActorKey(input.charter.id, input.iteration),
				prompt: worksPrompt(input),
				classify,
				resolve,
			});
			const parsed = parseProductArtifact(reply);
			if (!parsed.ok) rejectStructured(parsed.reason);
			return parsed.value;
		},
		async audit(
			input: AuditInput,
			route: ModelRoute,
		): Promise<AuditVerdict> {
			const reply = await runOffice({
				input,
				route,
				key: auditActorKey(input.charter.id, input.iteration, route),
				prompt: auditPrompt(input),
				classify,
				resolve,
			});
			const parsed = parseAuditVerdict(reply);
			if (!parsed.ok) rejectStructured(parsed.reason);
			return parsed.value;
		},
	};
}

interface RunOfficeArgs {
	input: PlanningInput | WorksInput | AuditInput;
	route: ModelRoute;
	key: PiOfficeActorKey;
	prompt: string;
	classify: PiOfficeErrorClassifier;
	resolve: PiOfficeActorResolver;
}

async function runOffice(args: RunOfficeArgs): Promise<string> {
	// Runtime guard at the bridge boundary: the route's thinking level
	// must be one of the accepted values before the resolver is even
	// invoked. A malformed value (cast, JSON-derived, or otherwise)
	// surfaces here so the caller can fix the wiring instead of
	// silently downgrading the request.
	const thinking = assertAcceptedThinking(args.route.thinking);
	const handle = args.resolve(args.key);
	// Only Pi action exceptions flow through the capacity classifier:
	// any failure raised by `setModel`, `setThinkingLevel`, `prompt`,
	// or `getLastAssistantText` itself is a candidate for remapping to
	// `ModelCapacityError`. The empty / non-string assistant text check is
	// deliberately evaluated outside it so even a classifier returning
	// `true` for every input cannot turn missing output into a capacity
	// error: the engine's fallback machinery and the strict parsers
	// rely on the missing-output signal propagating unchanged.
	let text: string | undefined;
	try {
		await handle.setModel(args.route.provider, args.route.model);
		await handle.setThinkingLevel(thinking);
		await handle.prompt(args.prompt);
		text = await handle.getLastAssistantText();
	} catch (error) {
		if (args.classify(error)) {
			const message =
				error instanceof Error
					? error.message
					: "Pi actor reported capacity exhaustion";
			throw new ModelCapacityError(message);
		}
		throw error;
	}
	if (typeof text !== "string" || text.length === 0) {
		throw new Error(
			"Pi actor returned no assistant text for the Mugamaa office call",
		);
	}
	return text;
}

function rejectStructured(reason: string): never {
	throw new Error(`Office output rejected: ${reason}`);
}
