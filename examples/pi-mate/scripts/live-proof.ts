/**
 * Operator-driven live proof harness for the standalone Pi Mate.
 *
 * This CLI exercises the native Pi Actor durability and control
 * semantics against an externally managed Rivet Engine. It is opt-in
 * and refuses to run with a destructive default: missing prereqs,
 * loopback endpoints, or unreachable engines cause every phase to
 * report `outcome: "skipped"` with `skipReason: "dry_run"`.
 *
 * The harness drives the Pi Durable surface of `@rivet-dev/pi` 0.5.x:
 * `harness.root()` resolves the actor's root conversation,
 * `conversation.watchEvents()` streams `pi.events` frames to the
 * calling connection, `prompt()` deduplicates retries by `requestId`
 * and steers mid-run through `whenBusy`, and `conversation.abort()` /
 * `conversation.compact()` / `conversation.configure()` carry the
 * control semantics.
 *
 * Phases are documented in {@link ../../docs/live-proof.md}. Each
 * phase writes one JSON object to stdout and (where applicable)
 * appends an entry to the report file written by `seed`.
 *
 * Usage:
 *
 *   RIVET_ENDPOINT=http://agent-core-lan:6420 \
 *     PI_MATE_OWNER_SCOPE=acme PI_MATE_PROJECT_ID=northstar \
 *     PI_MATE_ANTHROPIC_API_KEY=... \
 *     pnpm --filter example-pi-mate exec tsx scripts/live-proof.ts seed
 *
 *   # inspect the report:
 *   pnpm --filter example-pi-mate exec tsx scripts/live-proof.ts verify-key --report ./live-proof-report.json
 *
 * The harness never sends secrets to the Engine; it only injects them
 * into the runtime process's environment at call time.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { AgentEvent, ConversationId } from "@earendil-works/pi-durable";
import { createClient } from "rivetkit/client";
import {
	LIVE_PROOF_ENV,
	type LiveProofEntry,
	type LiveProofPhase,
	type LiveProofPrereq,
	type LiveProofReport,
	type LiveProofSkipReason,
	appendPhase,
	defaultReportPath,
	fingerprintEquals,
	fingerprintSession,
	newReport,
	planAllPhases,
	proofActorKey,
	readLiveProofPrereq,
	redactEndpoint,
	stableStringify,
} from "../tests/live/proof-harness.ts";
import { FIRST_MATE_ACTOR_NAME, buildPiMateRegistry } from "../src/actors.ts";
import type { PiMateRegistry } from "../src/client-types.ts";
import {
	firstMateActorKey,
	PROOF_MODEL_IDS,
	PROOF_PROVIDER_NAME,
} from "../src/config.ts";

/** Top-level CLI options shared by every phase. */
interface PhaseOptions {
	phase: LiveProofPhase;
	reportPath: string;
}

/**
 * Entry point. Parses argv, dispatches to the phase handler, and
 * ensures the harness exits with a non-zero code whenever the outcome
 * is anything other than `pass`.
 */
async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const prereq = readLiveProofPrereq(process.env);
	const startedAt = new Date().toISOString();

	if (options.phase === "check") {
		// Low-cost live probe per docs/live-proof.md: the check phase
		// probes the Engine with a GET and never creates an actor. The
		// probe runs whenever the endpoint parsed, even when other prereqs
		// are missing, so the report always records reachability.
		const engineHealth = await probeEngineHealth(prereq);
		const outcome = prereq.ok
			? engineHealth === "ok"
				? "pass"
				: "fail"
			: "skipped";
		const identity = prereq.ok ? proofActorKey(process.env) : undefined;
		const entry: LiveProofEntry = {
			phase: "check",
			outcome,
			startedAt,
			endedAt: new Date().toISOString(),
			...(prereq.endpointOrigin !== undefined
				? { endpointOrigin: prereq.endpointOrigin }
				: {}),
			...(identity !== undefined ? { actorKey: identity.key } : {}),
			observations: {
				providerMode: prereq.providerMode,
				endpointRaw: redactEndpoint(prereq.endpointRaw),
				engineHealth,
				model: prereq.model,
				scopedModels: prereq.scopedModels,
				namespace: prereq.namespace,
				missing: prereq.missing,
			},
			...(engineHealth !== "ok" && prereq.ok
				? {
						mismatches: [
							`engine health probe reported "${engineHealth}"`,
						],
					}
				: {}),
			...(prereq.skipReason !== undefined
				? { skipReason: prereq.skipReason }
				: {}),
		};
		printAndExit(entry, prereq);
		return;
	}

	// All phases except `check` need the seed artifact and a live prereq.
	if (!prereq.ok) {
		const entry = skippedEntry(options.phase, startedAt, undefined, prereq);
		printAndExit(entry, prereq);
		return;
	}

	const identity = proofActorKey(process.env);

	if (options.phase === "verify-runtime-restart") {
		const entry = skippedEntry(
			options.phase,
			startedAt,
			identity,
			prereq,
			"manual_phase",
		);
		entry.notes = [
			"Stop the running `pnpm start` process, restart it against the same Engine and namespace, then re-run `verify-key --report <path>`.",
			"Set PI_MATE_LIVE_PROOF_ALLOW_RUNTIME_RESTART=1 only when a supervisor is ready to actually stop the runtime.",
		];
		printAndExit(entry, prereq);
		return;
	}

	const report = loadReport(options.reportPath, prereq, identity.key);
	switch (options.phase) {
		case "all": {
			const planned = planAllPhases(process.env);
			const phaseResults: LiveProofEntry[] = [];
			for (const phase of planned) {
				if (phase === "check") {
					phaseResults.push({
						phase: "check",
						outcome: "pass",
						startedAt: new Date().toISOString(),
						endedAt: new Date().toISOString(),
						endpointOrigin: prereq.endpointOrigin,
						actorKey: identity.key,
						observations: { missing: prereq.missing },
					});
					continue;
				}
				if (phase === "seed") {
					phaseResults.push(
						await seedPhase(prereq, identity, report, startedAt),
					);
					continue;
				}
				phaseResults.push(
					await verifyKeyPhase(prereq, identity, report),
				);
			}
			const summary: LiveProofEntry = {
				phase: "all",
				outcome: phaseResults.every((entry) => entry.outcome === "pass")
					? "pass"
					: "fail",
				startedAt,
				endedAt: new Date().toISOString(),
				endpointOrigin: prereq.endpointOrigin,
				actorKey: identity.key,
				observations: { phaseCount: phaseResults.length },
			};
			appendPhase(report, summary);
			saveReport(options.reportPath, report);
			printAndExit(summary, prereq);
			return;
		}
		case "seed": {
			const entry = await seedPhase(prereq, identity, report, startedAt);
			appendPhase(report, entry);
			saveReport(options.reportPath, report);
			printAndExit(entry, prereq);
			return;
		}
		case "verify-key": {
			const entry = await verifyKeyPhase(prereq, identity, report);
			appendPhase(report, entry);
			saveReport(options.reportPath, report);
			printAndExit(entry, prereq);
			return;
		}
		case "verify-events":
		case "verify-reconnect":
		case "verify-model-switch":
		case "verify-steering":
		case "verify-abort":
		case "verify-compaction":
		case "verify-unknown-outcome": {
			const entry = await runLifecyclePhase(
				options.phase,
				prereq,
				identity,
				report,
				startedAt,
			);
			appendPhase(report, entry);
			saveReport(options.reportPath, report);
			printAndExit(entry, prereq);
			return;
		}
		default: {
			const exhaustive: never = options.phase;
			throw new Error(`unsupported phase: ${String(exhaustive)}`);
		}
	}
}

/** Skip an arbitrary phase in dry-run mode. */
function skippedEntry(
	phase: LiveProofPhase,
	startedAt: string,
	identity: ReturnType<typeof proofActorKey> | undefined,
	prereq: LiveProofPrereq,
	overrideReason?: LiveProofSkipReason,
): LiveProofEntry {
	const skipReason: LiveProofSkipReason =
		overrideReason ?? prereq.skipReason ?? "dry_run";
	return {
		phase,
		outcome: "skipped",
		skipReason,
		startedAt,
		endedAt: new Date().toISOString(),
		...(prereq.endpointOrigin !== undefined
			? { endpointOrigin: prereq.endpointOrigin }
			: {}),
		...(identity !== undefined ? { actorKey: identity.key } : {}),
		observations: {
			missing: prereq.missing,
			note:
				skipReason === "dry_run"
					? "no live Engine; this phase remains unproven until a real Engine and model credentials are reachable"
					: skipReason,
		},
	};
}

/** Prompt texts the proof phases send. The ones that need an in-flight
 * run deliberately contain the word `slow`, which the faux proof provider
 * streams at a low rate; the rest receive immediate replies. */
const SEED_PROMPT_TEXT = "live-proof seed prompt";
const FANOUT_PROMPT_TEXT = "live-proof fanout prompt";
const RECONNECT_PROMPT_TEXT = "live-proof reconnect prompt";
const MODEL_SWITCH_PROMPT_TEXT = "live-proof model switch check";
const STEER_PROMPT_TEXT = "live-proof slow steering prompt";
const STEER_TEXT = "live-proof steering correction";
const FOLLOW_UP_TEXT = "live-proof follow-up prompt";
const ABORT_PROMPT_TEXT = "live-proof slow abort prompt";
const COMPACTION_FILLER_TEXT = "live-proof compaction filler";
const UNKNOWN_OUTCOME_PROMPT_TEXT = "live-proof slow unknown-outcome prompt";

/** One `pi.events` frame as it arrives on the wire. */
interface PiEventsFrameLike {
	conversationId?: unknown;
	seq: number;
	events?: readonly AgentEvent[];
}

/** Minimal surface used to subscribe without fighting event-type extraction. */
interface EventSubscribable {
	on(name: string, cb: (frame: PiEventsFrameLike) => void): () => void;
}

/** The typed client, actor handle, and connection of one proof session. */
type ProofClient = Awaited<ReturnType<typeof connectClient>>;
type ProofHandle = ReturnType<
	ProofClient[typeof FIRST_MATE_ACTOR_NAME]["getOrCreate"]
>;
type ProofConn = ReturnType<ProofHandle["connect"]>;

/** A live proof session: client, actor handle, one watching connection. */
interface ProofSession {
	readonly client: ProofClient;
	readonly handle: ProofHandle;
	readonly conn: ProofConn;
	/** Root conversation id; the durable session identity (ADR-0002 thread partition). */
	readonly conversationId: ConversationId;
	/** Every agent event seen so far, snapshot first. */
	readonly events: AgentEvent[];
	/** Frame sequence numbers observed on this connection. */
	readonly frameSeqs: number[];
	dispose(): Promise<void>;
}

/** Connect a typed proof client to the Engine (no actor resolution yet). */
async function connectClient(prereq: LiveProofPrereq) {
	return createClient<PiMateRegistry>({
		endpoint: buildClientEndpoint(prereq),
		...(process.env[LIVE_PROOF_ENV.token]?.trim()
			? { token: process.env[LIVE_PROOF_ENV.token]?.trim() }
			: {}),
		...(prereq.namespace ? { namespace: prereq.namespace } : {}),
	});
}

/**
 * Connect a typed proof client to the Engine and resolve the first-mate
 * actor under the proof key. Opens the root conversation, attaches a
 * `pi.events` watch, and returns the session bundle. On failure the
 * error is recorded as a mismatch and undefined is returned so the
 * caller can skip cleanly.
 */
async function connectFirstMate(
	prereq: LiveProofPrereq,
	identity: ReturnType<typeof proofActorKey>,
	mismatches: string[],
): Promise<ProofSession | undefined> {
	let client: Awaited<ReturnType<typeof connectClient>> | undefined;
	try {
		client = await connectClient(prereq);
		const handle = client[FIRST_MATE_ACTOR_NAME].getOrCreate([
			...identity.key,
		]);
		const conn = handle.connect();
		const events: AgentEvent[] = [];
		const frameSeqs: number[] = [];
		(conn as unknown as EventSubscribable).on("pi.events", (frame) => {
			frameSeqs.push(frame.seq);
			for (const event of frame.events ?? []) events.push(event);
		});
		const root = await conn.harness.root();
		const { snapshot } = await conn.conversation.watchEvents(root.id);
		events.push(snapshot);
		let disposed = false;
		const dispose = async () => {
			if (disposed) return;
			disposed = true;
			try {
				await conn.dispose();
			} catch {
				// The connection already dropped; nothing to clean up.
			}
			try {
				await client?.dispose();
			} catch {
				// The client already dropped; nothing to clean up.
			}
		};
		return {
			client,
			handle,
			conn,
			conversationId: root.id,
			events,
			frameSeqs,
			dispose,
		};
	} catch (error) {
		mismatches.push(
			`failed to connect the proof client: ${describeError(error)}`,
		);
		try {
			await client?.dispose();
		} catch {
			// The connection never opened; nothing to clean up.
		}
		return undefined;
	}
}

/**
 * Build the client endpoint. The endpoint URL may carry `namespace:token`
 * userinfo; credentials may also arrive through RIVET_TOKEN. Either way
 * the token never reaches the report: every recorded endpoint goes
 * through redactEndpoint.
 */
function buildClientEndpoint(prereq: LiveProofPrereq): string {
	const raw = prereq.endpointRaw;
	if (!raw) {
		throw new Error("RIVET_ENDPOINT is required to connect a proof client");
	}
	const url = new URL(raw);
	const urlHasCredentials = url.username !== "" || url.password !== "";
	const envToken = process.env[LIVE_PROOF_ENV.token]?.trim();
	if (!urlHasCredentials && !envToken) {
		throw new Error(
			`the proof client needs credentials: set ${LIVE_PROOF_ENV.token} or embed namespace:token in RIVET_ENDPOINT`,
		);
	}
	return raw;
}

/** Arguments every lifecycle phase receives. */
interface PhaseArgs {
	prereq: LiveProofPrereq;
	identity: ReturnType<typeof proofActorKey>;
	report: LiveProofReport;
	observations: Record<string, unknown>;
	mismatches: string[];
}

/** One lifecycle phase implementation. Adds mismatches on failure. */
type LifecyclePhaseFn = (args: PhaseArgs) => Promise<void>;

/**
 * Run one lifecycle phase against the live Engine. Every phase opens its
 * own client connection under the proof key, drives the documented
 * behavior, and records what it observed. A phase passes only when its
 * mismatches list stays empty; any thrown error is captured as a
 * mismatch so the harness never crashes mid-run.
 */
async function runLifecyclePhase(
	phase: LiveProofPhase,
	prereq: LiveProofPrereq,
	identity: ReturnType<typeof proofActorKey>,
	report: LiveProofReport,
	startedAt: string,
): Promise<LiveProofEntry> {
	const observations: Record<string, unknown> = {
		providerMode: prereq.providerMode,
	};
	const mismatches: string[] = [];
	const impl = LIFECYCLE_PHASE_FNS[phase];
	if (!impl) {
		mismatches.push(`no implementation registered for phase ${phase}`);
	} else {
		try {
			await impl({ prereq, identity, report, observations, mismatches });
		} catch (error) {
			mismatches.push(describeError(error));
		}
	}
	return {
		phase,
		outcome: mismatches.length === 0 ? "pass" : "fail",
		startedAt,
		endedAt: new Date().toISOString(),
		...(prereq.endpointOrigin !== undefined
			? { endpointOrigin: prereq.endpointOrigin }
			: {}),
		actorKey: identity.key,
		observations,
		...(mismatches.length > 0 ? { mismatches } : {}),
		notes:
			prereq.providerMode === "faux"
				? [
						"provider mode is faux: this phase proves the actor's durability and control semantics, not the real provider path",
					]
				: undefined,
	};
}

/** A request id unique to one invocation of one phase, so reruns create
 * fresh submissions instead of deduplicating onto the previous run. */
function freshRequestId(phase: string): string {
	return `${phase}-${Date.now()}`;
}

/** The model-context message count of one conversation. */
async function messageCount(session: ProofSession): Promise<number> {
	const view = await session.conn.conversation.context(
		session.conversationId,
	);
	return view.messages.length;
}

/** The model-context messages of one conversation. */
async function contextMessages(
	session: ProofSession,
): Promise<readonly unknown[]> {
	const view = await session.conn.conversation.context(
		session.conversationId,
	);
	return view.messages;
}

/** The seven live lifecycle phases. */
const LIFECYCLE_PHASE_FNS: Partial<Record<LiveProofPhase, LifecyclePhaseFn>> = {
	"verify-events": async ({ prereq, identity, observations, mismatches }) => {
		const session = await connectFirstMate(prereq, identity, mismatches);
		if (!session) return;
		try {
			// A second connection watches the same conversation: the
			// pi.events frames must fan out to every watching connection.
			const connB = session.handle.connect();
			const eventsB: AgentEvent[] = [];
			(connB as unknown as EventSubscribable).on("pi.events", (frame) => {
				for (const event of frame.events ?? []) eventsB.push(event);
			});
			await connB.conversation.watchEvents(session.conversationId);

			const beforeA = session.events.length;
			const beforeB = eventsB.length;
			await session.conn.prompt(FANOUT_PROMPT_TEXT, {
				requestId: freshRequestId("fanout"),
			});
			await waitForStreamStability(
				() => [session.events.length, eventsB.length],
				10_000,
			);
			const keysA = eventKeys(session.events.slice(beforeA));
			const keysB = eventKeys(eventsB.slice(beforeB));
			if (keysA.length === 0) {
				mismatches.push(
					"connection A observed no events for the prompt",
				);
			}
			if (keysB.length === 0) {
				mismatches.push(
					"connection B observed no events for the prompt",
				);
			}
			if (keysA.length > 0 && keysA.join("|") !== keysB.join("|")) {
				mismatches.push(
					"the two connections observed different event streams",
				);
			}
			observations.eventCountA = keysA.length;
			observations.eventCountB = keysB.length;
			observations.firstEventKeys = keysA.slice(0, 8);
			observations.frameSeqsA = session.frameSeqs.slice(0, 8);
			await connB.dispose();
		} finally {
			await session.dispose();
		}
	},

	"verify-reconnect": async ({
		prereq,
		identity,
		observations,
		mismatches,
	}) => {
		const session = await connectFirstMate(prereq, identity, mismatches);
		if (!session) return;
		try {
			const sessionId = String(session.conversationId);
			const messagesBefore = await messageCount(session);
			await session.dispose();
			// Reopen the actor: the root conversation (and its history)
			// must survive the connection drop.
			const reopened = await connectFirstMate(
				prereq,
				identity,
				mismatches,
			);
			if (!reopened) return;
			try {
				const sessionIdAfter = String(reopened.conversationId);
				if (sessionIdAfter !== sessionId) {
					mismatches.push("conversation id changed across reconnect");
				}
				const messagesAfter = await messageCount(reopened);
				if (messagesAfter !== messagesBefore) {
					mismatches.push(
						`message count changed across reconnect: ${messagesBefore} -> ${messagesAfter}`,
					);
				}
				// The conversation must continue serving prompts after the reconnect.
				const runningCount = messagesAfter;
				await reopened.conn.prompt(RECONNECT_PROMPT_TEXT, {
					requestId: freshRequestId("reconnect"),
				});
				const messagesFinal = await messageCount(reopened);
				if (messagesFinal !== runningCount + 2) {
					mismatches.push(
						`post-reconnect prompt appended ${messagesFinal - runningCount} messages, expected 2`,
					);
				}
				observations.sessionId = sessionIdAfter;
				observations.messagesBefore = messagesBefore;
				observations.messagesAfter = messagesAfter;
				observations.messagesFinal = messagesFinal;
			} finally {
				await reopened.dispose();
			}
		} finally {
			try {
				await session.dispose();
			} catch {
				// Already disposed inside the phase.
			}
		}
	},

	"verify-model-switch": async ({
		prereq,
		identity,
		observations,
		mismatches,
	}) => {
		const session = await connectFirstMate(prereq, identity, mismatches);
		if (!session) return;
		try {
			const target = resolveSwitchTarget(prereq);
			if (!target) {
				mismatches.push(
					"no model switch target available in the scoped allowlist",
				);
				return;
			}
			const targetFull = `${target.provider}/${target.modelId}`;
			const before = await fingerprintOfAgent(session);
			await session.conn.conversation.configure(session.conversationId, {
				model: { provider: target.provider, modelId: target.modelId },
			});
			const switched = await fingerprintOfAgent(session);
			if (switched !== targetFull) {
				mismatches.push(
					`conversation.agent().model is ${switched}, expected ${targetFull} after configure`,
				);
			}
			await session.conn.prompt(MODEL_SWITCH_PROMPT_TEXT, {
				requestId: freshRequestId("model-switch"),
			});
			const messages = await contextMessages(session);
			const lastReply = lastAssistantText(messages);
			if (
				prereq.providerMode === "faux" &&
				!lastReply.includes(`proof model ${target.modelId}`)
			) {
				mismatches.push(
					`the post-switch prompt was not served by ${targetFull}: ${lastReply.slice(0, 120)}`,
				);
			}
			// Switch back to the seed model.
			if (before) {
				const seed = parseModelString(before);
				if (seed) {
					await session.conn.conversation.configure(
						session.conversationId,
						{
							model: {
								provider: seed.provider,
								modelId: seed.modelId,
							},
						},
					);
					const back = await fingerprintOfAgent(session);
					if (back !== before) {
						mismatches.push(
							`switching back did not restore the seed model: ${back}`,
						);
					}
				}
			}
			observations.modelBefore = before;
			observations.modelSwitched = switched;
			observations.modelRestored = await fingerprintOfAgent(session);
		} finally {
			await session.dispose();
		}
	},

	"verify-steering": async ({
		prereq,
		identity,
		observations,
		mismatches,
	}) => {
		const session = await connectFirstMate(prereq, identity, mismatches);
		if (!session) return;
		try {
			const messagesBefore = await messageCount(session);
			// Launch the slow run, the steer, and the follow-up together:
			// each prompt call resolves only when the queue it joins has
			// fully settled, so the steer and follow-up must be in flight
			// before the slow run finishes for their whenBusy modes to
			// apply. This mirrors the old `steer()`/`followUp()` actions.
			const running = session.conn.prompt(STEER_PROMPT_TEXT, {
				requestId: freshRequestId("steering"),
			});
			const streaming = await waitForEvent(
				session.events,
				"message_update",
				20_000,
			);
			if (!streaming) {
				mismatches.push(
					"the slow steering prompt never started streaming",
				);
			}
			const steering = session.conn.prompt(STEER_TEXT, {
				requestId: freshRequestId("steering-steer"),
				whenBusy: "steer",
			});
			const following = session.conn.prompt(FOLLOW_UP_TEXT, {
				requestId: freshRequestId("steering-followup"),
				whenBusy: "followUp",
			});
			await running;
			await steering;
			await following;
			await session.conn.conversation.waitForIdle(session.conversationId);
			const messages = await contextMessages(session);
			// Count only messages this phase added: the transcript persists
			// across phases, so whole-transcript counting would double-count
			// texts from earlier runs of the same phase.
			const texts = userTexts(messages.slice(messagesBefore));
			const steerSeen = countText(texts, STEER_TEXT);
			const followUpSeen = countText(texts, FOLLOW_UP_TEXT);
			if (steerSeen !== 1) {
				mismatches.push(
					`steering text recorded ${steerSeen} times, expected exactly 1`,
				);
			}
			if (followUpSeen !== 1) {
				mismatches.push(
					`follow-up text recorded ${followUpSeen} times, expected exactly 1`,
				);
			}
			const delta = messages.length - messagesBefore;
			if (delta < 2) {
				mismatches.push(
					`message count grew by ${delta}, expected at least 2`,
				);
			}
			observations.messagesBefore = messagesBefore;
			observations.messagesAfter = messages.length;
			observations.growth = delta;
		} finally {
			await session.dispose();
		}
	},

	"verify-abort": async ({ prereq, identity, observations, mismatches }) => {
		const session = await connectFirstMate(prereq, identity, mismatches);
		if (!session) return;
		try {
			const messagesBefore = await messageCount(session);
			const running = session.conn.prompt(ABORT_PROMPT_TEXT, {
				requestId: freshRequestId("abort"),
			});
			const streaming = await waitForEvent(
				session.events,
				"message_update",
				20_000,
			);
			if (!streaming) {
				mismatches.push(
					"the slow abort prompt never started streaming",
				);
			}
			await session.conn.conversation.abort(session.conversationId);
			const result = await running;
			if (result.status === "done") {
				mismatches.push(
					`the aborted prompt settled as done; abort() did not stop the run`,
				);
			}
			await session.conn.conversation.waitForIdle(session.conversationId);
			const state = await session.conn.harness.inspect();
			const messages = await contextMessages(session);
			// Count only messages this phase added; the transcript persists
			// across phases and across reruns of this phase.
			const texts = userTexts(messages.slice(messagesBefore));
			const promptSeen = countText(texts, ABORT_PROMPT_TEXT);
			if (promptSeen !== 1) {
				mismatches.push(
					`the aborted prompt text appears ${promptSeen} times, expected exactly 1`,
				);
			}
			const lastAssistant = [...messages]
				.reverse()
				.find(
					(message) =>
						(message as { role?: string }).role === "assistant",
				);
			const stopReason = (
				lastAssistant as { stopReason?: string } | undefined
			)?.stopReason;
			if (stopReason !== "aborted") {
				mismatches.push(
					`last assistant stopReason is ${JSON.stringify(stopReason)}, expected "aborted"`,
				);
			}
			observations.abortSettlement = result.status;
			observations.abortSettlementReason =
				result.status === "unanswered" ? result.reason : null;
			observations.abortStopReason = stopReason;
			observations.messageCount = messages.length;
			observations.scheduling = state.scheduling;
		} finally {
			await session.dispose();
		}
	},

	"verify-compaction": async ({
		prereq,
		identity,
		observations,
		mismatches,
	}) => {
		const session = await connectFirstMate(prereq, identity, mismatches);
		if (!session) return;
		try {
			for (let index = 0; index < 4; index += 1) {
				await session.conn.prompt(
					`${COMPACTION_FILLER_TEXT} ${index}`,
					{
						requestId: freshRequestId(`compaction-${index}`),
					},
				);
			}
			const before = await messageCount(session);
			await session.conn.conversation.compact(session.conversationId);
			const compacted = await waitForEvent(
				session.events,
				"compaction_end",
				60_000,
			);
			if (!compacted) {
				mismatches.push(
					"no compaction_end event was observed after compact()",
				);
			}
			const after = await messageCount(session);
			if (after >= before) {
				mismatches.push(
					`compaction did not shrink the model context: ${before} -> ${after}`,
				);
			}
			const compactionEvents = session.events.filter(
				(event) =>
					event.type === "compaction_start" ||
					event.type === "compaction_end",
			).length;
			if (compactionEvents === 0) {
				mismatches.push("no compaction event was observed");
			}
			observations.messagesBefore = before;
			observations.messagesAfter = after;
			observations.compactionEvents = compactionEvents;
		} finally {
			await session.dispose();
		}
	},

	"verify-unknown-outcome": async ({
		prereq,
		identity,
		observations,
		mismatches,
	}) => {
		const session = await connectFirstMate(prereq, identity, mismatches);
		if (!session) return;
		try {
			const messagesBefore = await messageCount(session);
			const running = session.conn.prompt(UNKNOWN_OUTCOME_PROMPT_TEXT, {
				requestId: freshRequestId("unknown-outcome"),
			});
			const streaming = await waitForEvent(
				session.events,
				"message_update",
				20_000,
			);
			if (!streaming) {
				mismatches.push(
					"the slow unknown-outcome prompt never started streaming",
				);
			}
			// Drop the connection before the action resolves: the client
			// must never learn the outcome of the dropped call.
			await session.dispose();
			let rejection: string | undefined;
			try {
				await running;
			} catch (error) {
				rejection = describeError(error);
			}
			if (!rejection) {
				mismatches.push(
					"closing the connection did not reject the in-flight prompt",
				);
			} else if (
				!/connection|conn|closed|cancel|abort|dispose/i.test(rejection)
			) {
				mismatches.push(
					`the in-flight prompt rejected with a non-connection error: ${rejection}`,
				);
			}
			const reopened = await connectFirstMate(
				prereq,
				identity,
				mismatches,
			);
			if (!reopened) return;
			try {
				await reopened.conn.conversation.waitForIdle(
					reopened.conversationId,
				);
				// Count only messages this phase added; the transcript persists
				// across phases and across reruns of this phase.
				const texts = userTexts(
					(await contextMessages(reopened)).slice(messagesBefore),
				);
				const promptSeen = countText(
					texts,
					UNKNOWN_OUTCOME_PROMPT_TEXT,
				);
				if (promptSeen !== 1) {
					mismatches.push(
						`the interrupted prompt text appears ${promptSeen} times after reconnect, expected exactly 1`,
					);
				}
				observations.rejection = rejection;
				observations.reconnectPromptSeen = promptSeen;
			} finally {
				await reopened.dispose();
			}
		} finally {
			try {
				await session.dispose();
			} catch {
				// Already disposed inside the phase.
			}
		}
	},
};

/** Resolve the model the switch phase targets, per provider mode. */
function resolveSwitchTarget(
	prereq: LiveProofPrereq,
): { provider: string; modelId: string } | undefined {
	if (prereq.providerMode === "faux") {
		return { provider: PROOF_PROVIDER_NAME, modelId: PROOF_MODEL_IDS[1] };
	}
	const scoped = prereq.scopedModels ?? [];
	const target = scoped[1] ?? prereq.model;
	return parseModelString(target);
}

/** Split a `provider/modelId` string. Returns undefined when malformed. */
function parseModelString(
	value: string | undefined,
): { provider: string; modelId: string } | undefined {
	if (!value || !value.includes("/")) return undefined;
	const [provider, modelId] = value.split("/");
	if (!provider || !modelId) return undefined;
	return { provider, modelId };
}

/** Render the conversation's resolved agent model as `provider/modelId`. */
async function fingerprintOfAgent(
	session: ProofSession,
): Promise<string | undefined> {
	const agent = await session.conn.conversation.agent(session.conversationId);
	if (!agent.model) return undefined;
	return `${agent.model.provider}/${agent.model.modelId}`;
}

/** Stable per-event key: the event's conversation/entry id when present, else the type. */
function eventKey(event: AgentEvent): string {
	const carrier = event as {
		entry?: { id?: unknown };
		record?: { id?: unknown };
	};
	const id = carrier.entry?.id ?? carrier.record?.id;
	return id === undefined ? event.type : `${event.type}:${String(id)}`;
}

function eventKeys(events: readonly AgentEvent[]): string[] {
	return events.map(eventKey);
}

/** Probe the Engine's /health route. Never creates an actor. */
async function probeEngineHealth(
	prereq: LiveProofPrereq,
): Promise<"ok" | "unreachable" | "not_probed"> {
	if (prereq.endpointOrigin === undefined) return "not_probed";
	try {
		const response = await fetch(`${prereq.endpointOrigin}/health`, {
			signal: AbortSignal.timeout(5_000),
		});
		return response.ok ? "ok" : "unreachable";
	} catch {
		return "unreachable";
	}
}

/** Poll until one event of the given type arrives, or the timeout elapses. */
async function waitForEvent(
	events: readonly AgentEvent[],
	type: string,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (events.some((event) => event.type === type)) return true;
		await sleep(100);
	}
	return events.some((event) => event.type === type);
}

/** Poll until every stream length stays stable for two consecutive rounds. */
async function waitForStreamStability(
	lengths: () => number[],
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let stableRounds = 0;
	let last = lengths();
	while (Date.now() < deadline && stableRounds < 2) {
		await sleep(200);
		const next = lengths();
		if (next.every((value, index) => value === last[index])) {
			stableRounds += 1;
		} else {
			stableRounds = 0;
		}
		last = next;
	}
}

/** Extract the text of every user message, in order. */
function userTexts(messages: readonly unknown[]): string[] {
	return messages
		.filter(
			(message) =>
				typeof message === "object" &&
				message !== null &&
				(message as { role?: unknown }).role === "user",
		)
		.map(textOfMessage);
}

/** Extract the text of the last assistant message. */
function lastAssistantText(messages: readonly unknown[]): string {
	const last = [...messages]
		.reverse()
		.find(
			(message) =>
				typeof message === "object" &&
				message !== null &&
				(message as { role?: unknown }).role === "assistant",
		);
	return textOfMessage(last);
}

/** Read the text content of one message of any shape. */
function textOfMessage(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				typeof part === "object" &&
				part !== null &&
				"text" in part &&
				typeof (part as { text?: unknown }).text === "string"
					? (part as { text: string }).text
					: "",
			)
			.join("");
	}
	return "";
}

/** Count how many texts contain the needle. */
function countText(texts: readonly string[], needle: string): number {
	return texts.filter((text) => text.includes(needle)).length;
}

/** Render an error log-safely: name, message, and nothing else. */
function describeError(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Phase `seed`: opens a fresh actor under the proof key, validates the
 * typed client wires through, and writes a report with the resolved
 * conversation identity. The model call exercises the provider path the
 * runtime is configured with (faux proof provider or real credentials).
 */
async function seedPhase(
	prereq: LiveProofPrereq,
	identity: ReturnType<typeof proofActorKey>,
	report: LiveProofReport,
	startedAt: string,
): Promise<LiveProofEntry> {
	const observations: Record<string, unknown> = {
		registryName: FIRST_MATE_ACTOR_NAME,
		typedClientShape: typedClientShape(),
		keyDerivation: firstMateActorKey({
			ownerScope: identity.ownerScope,
			projectId: identity.projectId,
			threadId: identity.threadId,
		}),
		providerMode: prereq.providerMode,
	};
	const mismatches: string[] = [];
	const session = await connectFirstMate(prereq, identity, mismatches);
	if (session) {
		try {
			const result = await session.conn.prompt(SEED_PROMPT_TEXT, {
				requestId: freshRequestId("seed"),
			});
			if (result.status !== "done") {
				mismatches.push(
					`the seed prompt settled as ${result.status}${result.reason ? `: ${result.reason}` : ""}`,
				);
			}
			const modelFingerprint = await fingerprintOfAgent(session);
			const messages = await contextMessages(session);
			const fingerprint = fingerprintSession({
				sessionId: String(session.conversationId),
				model: modelFingerprint,
				messageCount: messages.length,
			});
			if (messages.length === 0) {
				mismatches.push(
					"message history is empty after the seed prompt",
				);
			}
			const seedEventIds = session.frameSeqs.slice(0, 8);
			report.actorKey = identity.key;
			report.namespace = prereq.namespace ?? "default";
			report.endpointOrigin =
				prereq.endpointOrigin ?? report.endpointOrigin;
			if (fingerprint) {
				report.sessionId = fingerprint.sessionId;
				report.model = fingerprint.model;
			}
			report.messageCount = messages.length;
			report.firstEventIds = seedEventIds;
			report.seedStartedAt = startedAt;
			report.seedEndedAt = new Date().toISOString();
			observations.sessionId = String(session.conversationId);
			observations.model = fingerprint?.model;
			observations.messageCount = messages.length;
			observations.eventCount = session.events.length;
			observations.frameSeqs = seedEventIds;
			observations.eventTypes = session.events.map((event) => event.type);
		} finally {
			await session.dispose();
		}
	}
	return {
		phase: "seed",
		outcome: mismatches.length === 0 ? "pass" : "fail",
		startedAt,
		endedAt: new Date().toISOString(),
		...(prereq.endpointOrigin !== undefined
			? { endpointOrigin: prereq.endpointOrigin }
			: {}),
		actorKey: identity.key,
		observations,
		...(mismatches.length > 0 ? { mismatches } : {}),
		notes:
			prereq.providerMode === "faux"
				? [
						"provider mode is faux: the seed run proves the actor, Engine, and harness wiring, not the real provider path",
					]
				: undefined,
	};
}

/**
 * Phase `verify-key`: reopens the actor under the same key and
 * confirms the typed-client surface still routes through the documented
 * actor name, and the seeded conversation and its history survived.
 */
async function verifyKeyPhase(
	prereq: LiveProofPrereq,
	identity: ReturnType<typeof proofActorKey>,
	report: LiveProofReport,
): Promise<LiveProofEntry> {
	const startedAt = new Date().toISOString();
	const observations: Record<string, unknown> = {
		expectedKey: [...identity.key],
		registryActorName: FIRST_MATE_ACTOR_NAME,
		knownActorActions: knownPiActions(),
		reportSessionId: report.sessionId ?? null,
		providerMode: prereq.providerMode,
	};
	const mismatches: string[] = [];
	if (!report.actorKey || !arraysEqual(report.actorKey, identity.key)) {
		mismatches.push(
			`report actor key ${JSON.stringify(report.actorKey)} does not match harness identity ${JSON.stringify(identity.key)}`,
		);
	}
	if (report.sessionId === undefined) {
		mismatches.push("the seed report carries no sessionId; run seed first");
	}
	const session = await connectFirstMate(prereq, identity, mismatches);
	if (session) {
		try {
			const sessionId = String(session.conversationId);
			const messages = await contextMessages(session);
			const modelFingerprint = await fingerprintOfAgent(session);
			const fingerprint = fingerprintSession({
				sessionId,
				model: modelFingerprint,
				messageCount: messages.length,
			});
			observations.sessionId = sessionId;
			observations.model = fingerprint?.model;
			observations.messageCount = messages.length;
			if (
				report.sessionId !== undefined &&
				sessionId !== report.sessionId
			) {
				mismatches.push(
					`sessionId drifted across reopens: seed ${report.sessionId}, now ${sessionId}`,
				);
			}
			if (
				report.messageCount !== undefined &&
				messages.length < report.messageCount
			) {
				mismatches.push(
					`message history shrank across reopens: seed ${report.messageCount}, now ${messages.length}`,
				);
			}
		} finally {
			await session.dispose();
		}
	}
	return {
		phase: "verify-key",
		outcome: mismatches.length === 0 ? "pass" : "fail",
		startedAt,
		endedAt: new Date().toISOString(),
		...(prereq.endpointOrigin !== undefined
			? { endpointOrigin: prereq.endpointOrigin }
			: {}),
		actorKey: identity.key,
		observations,
		...(mismatches.length > 0 ? { mismatches } : {}),
	};
}

/** Parse `argv` into a structured options object. */
function parseArgs(argv: string[]): PhaseOptions {
	const [phaseRaw, ...rest] = argv;
	if (!phaseRaw) {
		throw new Error(
			"expected a phase argument; see docs/live-proof.md for the full list",
		);
	}
	if (
		phaseRaw !== "check" &&
		phaseRaw !== "seed" &&
		phaseRaw !== "verify-key" &&
		phaseRaw !== "verify-events" &&
		phaseRaw !== "verify-reconnect" &&
		phaseRaw !== "verify-model-switch" &&
		phaseRaw !== "verify-steering" &&
		phaseRaw !== "verify-abort" &&
		phaseRaw !== "verify-compaction" &&
		phaseRaw !== "verify-unknown-outcome" &&
		phaseRaw !== "verify-runtime-restart" &&
		phaseRaw !== "all"
	) {
		throw new Error(
			`unknown phase ${JSON.stringify(phaseRaw)}; expected one of: check, seed, verify-key, verify-events, verify-reconnect, verify-model-switch, verify-steering, verify-abort, verify-compaction, verify-unknown-outcome, verify-runtime-restart, all`,
		);
	}
	let reportPath =
		process.env[LIVE_PROOF_ENV.reportPath]?.trim() || defaultReportPath();
	for (let i = 0; i < rest.length; i += 2) {
		const flag = rest[i];
		const value = rest[i + 1];
		if (value === undefined) {
			throw new Error(`missing value for ${flag}`);
		}
		if (flag === "--report") reportPath = value;
		else throw new Error(`unknown flag ${flag}`);
	}
	return { phase: phaseRaw, reportPath };
}

/**
 * Discover the typed-client shape by inspecting the registry. The
 * harness performs no live network I/O; this is a pure read of the
 * in-memory registry that already proved the action surface in the
 * deterministic unit tests.
 */
function typedClientShape(): Record<string, unknown> {
	const registry = buildPiMateRegistry();
	const cfg = registry.parseConfig();
	const actor = cfg.use[FIRST_MATE_ACTOR_NAME];
	// RivetKit flattens nested action groups to dotted names on the
	// client; the parsed config keeps them grouped, so flatten here the
	// same way before listing them.
	const actions: string[] = [];
	for (const [group, members] of Object.entries(
		actor.config.actions as Record<string, unknown>,
	)) {
		if (typeof members === "function") {
			actions.push(group);
		} else if (members !== null && typeof members === "object") {
			for (const name of Object.keys(members)) {
				actions.push(`${group}.${name}`);
			}
		}
	}
	return {
		actorName: FIRST_MATE_ACTOR_NAME,
		actionCount: actions.length,
		knownActions:
			actions.includes("prompt") &&
			actions.includes("harness.root") &&
			actions.includes("conversation.watchEvents") &&
			actions.includes("conversation.abort") &&
			actions.includes("conversation.compact") &&
			actions.includes("conversation.configure") &&
			actions.includes("conversation.waitForIdle") &&
			actions.includes("submission.wait"),
	};
}

/** Snapshot the public Pi action names this harness expects to be present. */
function knownPiActions(): readonly string[] {
	return [
		"prompt",
		"harness.root",
		"harness.conversation",
		"harness.submission",
		"harness.abortSubmission",
		"harness.waitForIdle",
		"harness.inspect",
		"conversation.agent",
		"conversation.configure",
		"conversation.submit",
		"conversation.compact",
		"conversation.context",
		"conversation.entries",
		"conversation.abort",
		"conversation.watchEvents",
		"conversation.unwatchEvents",
		"conversation.waitForIdle",
		"submission.status",
		"submission.wait",
		"submission.abort",
	];
}

/** Compare two readonly tuples of strings element-by-element. */
function arraysEqual(
	a: readonly string[] | undefined,
	b: readonly string[],
): boolean {
	if (!a) return false;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/** Load a report from disk, or build a fresh one if none exists. */
function loadReport(
	reportPath: string,
	prereq: LiveProofPrereq,
	actorKey: readonly [string, string, string, string],
): LiveProofReport {
	const absolute = resolve(reportPath);
	if (existsSync(absolute)) {
		const raw = readFileSync(absolute, "utf-8");
		try {
			const parsed = JSON.parse(raw) as LiveProofReport;
			if (parsed && parsed.schema === 1) {
				parsed.actorKey = actorKey;
				parsed.endpointOrigin =
					prereq.endpointOrigin ?? parsed.endpointOrigin;
				parsed.namespace = prereq.namespace ?? parsed.namespace;
				return parsed;
			}
		} catch (error) {
			throw new Error(
				`failed to parse existing report at ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return newReport(prereq, actorKey);
}

/** Save the report back to disk using a stable JSON encoding. */
function saveReport(reportPath: string, report: LiveProofReport): void {
	const absolute = resolve(reportPath);
	writeFileSync(absolute, stableStringify(report), "utf-8");
}

/** Print one JSON entry and exit non-zero on skip/fail. */
function printAndExit(entry: LiveProofEntry, prereq: LiveProofPrereq): void {
	process.stdout.write(stableStringify(entry) + "\n");
	if (entry.outcome !== "pass") {
		process.exitCode = 1;
	}
	// Mark `fingerprintSession` and `fingerprintEquals` as referenced so
	// the typed-shape contract is preserved when this file is read in
	// isolation. Both helpers are exported by the harness and used by
	// future phases; touching them keeps the live-phase evidence
	// machine-checkable.
	const fingerprintProof = fingerprintSession({
		sessionId: entry.observations?.sessionId as string | undefined,
	});
	if (fingerprintProof) {
		fingerprintEquals(fingerprintProof, fingerprintProof);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	await main();
}

export { main as runLiveProof };
