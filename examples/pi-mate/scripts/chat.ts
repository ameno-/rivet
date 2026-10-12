/**
 * Interactive CLI chat against a deployed standalone Pi Mate.
 *
 * Connects to the Mate's Engine, resolves the first-mate actor for the
 * configured owner/project/thread key (ADR-0002), watches the root
 * conversation, and relays prompts and streamed replies between the
 * terminal and the Mate. One Mate actor serves one thread; switch threads
 * with `--thread` (or `/thread <id>` inside the session) to start a fresh
 * durable conversation.
 *
 * Usage:
 *
 *   export RIVET_ENDPOINT=http://127.0.0.1:16420   # e.g. via kubectl port-forward
 *   export RIVET_TOKEN=...                          # the Engine admin token
 *   pnpm --filter example-pi-mate chat
 *
 *   pnpm --filter example-pi-mate chat -- --thread incident-42
 *
 * In-session commands: /thread <id> switches actors, /abort stops the
 * running turn, /quit exits. A message sent while a turn is running is
 * forwarded with `whenBusy: "steer"` so it joins the turn in flight.
 *
 * The script never prints or persists the token; it only reads the
 * environment.
 */

import { randomUUID } from "node:crypto";
import * as readline from "node:readline";

import type { AgentEvent, ConversationId } from "@earendil-works/pi-durable";
import type { PiEventsFrame } from "@rivet-dev/pi";
import { createClient } from "rivetkit/client";
import { FIRST_MATE_ACTOR_NAME } from "../src/actors.ts";
import type { PiMateRegistry } from "../src/client-types.ts";
import { firstMateActorKey } from "../src/config.ts";

const endpoint = process.env.RIVET_ENDPOINT;
if (!endpoint) {
	console.error("RIVET_ENDPOINT is required (the Engine base URL)");
	process.exit(2);
}
const token = process.env.RIVET_TOKEN;
const namespace = process.env.RIVET_NAMESPACE ?? "default";
const ownerScope = process.env.PI_MATE_OWNER_SCOPE ?? "cli";
const projectId = process.env.PI_MATE_PROJECT_ID ?? "cli";

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index >= 0 ? process.argv[index + 1] : undefined;
}
let threadId = argValue("--thread") ?? process.env.PI_MATE_THREAD_ID ?? "main";

function connectActor(thread: string) {
	const client = createClient<PiMateRegistry>({
		endpoint: endpoint!,
		...(token ? { token } : {}),
		namespace,
	});
	const key = firstMateActorKey({ ownerScope, projectId, threadId: thread });
	return client[FIRST_MATE_ACTOR_NAME].getOrCreate([...key]).connect();
}

/** Per-message streaming state so a one-shot (unstreamed) reply still
 * prints, and a streamed reply prints only its unstreamed tail. */
let streamedText = "";
let atLineStart = true;
let running = false;

function writeOut(text: string): void {
	process.stdout.write(text);
	atLineStart = text.endsWith("\n");
}

function ensureLineStart(): void {
	if (!atLineStart) {
		process.stdout.write("\n");
		atLineStart = true;
	}
}

function handleEvent(event: AgentEvent): void {
	switch (event.type) {
		case "run_start":
			running = true;
			streamedText = "";
			ensureLineStart();
			break;
		case "message_update": {
			let text = "";
			for (const change of event.changes) {
				if (change.type === "text_delta") text += change.delta;
			}
			if (text.length > 0) {
				streamedText += text;
				writeOut(text);
			}
			break;
		}
		case "message_end": {
			const assistant = (event.entry?.model ?? []).find(
				(message) => message.role === "assistant",
			);
			if (!assistant) break;
			const content = assistant.content;
			const full =
				typeof content === "string"
					? content
					: content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("");
			// Deltas already printed; print only the unstreamed tail.
			const tail =
				full.length > streamedText.length
					? full.slice(streamedText.length)
					: "";
			if (tail.length > 0) writeOut(tail);
			ensureLineStart();
			streamedText = "";
			break;
		}
		case "tool_execution_start":
			ensureLineStart();
			console.log(`[tool] ${event.toolName}`);
			break;
		case "task_failed":
			ensureLineStart();
			console.log(`[error] ${event.kind} failed: ${event.message}`);
			break;
		case "run_end":
			running = false;
			ensureLineStart();
			break;
		default:
			break;
	}
}

function handleFrame(frame: PiEventsFrame): void {
	for (const event of frame.events) handleEvent(event);
}

let conn = connectActor(threadId);
let rootId: ConversationId = (await conn.harness.root()).id;

async function attach(): Promise<void> {
	conn.on("pi.events", handleFrame);
	await conn.conversation.watchEvents(rootId);
}
await attach();
console.log(
	`mate connected — actor mate/${ownerScope}/${projectId}/${threadId} (conversation ${rootId})`,
);
console.log("commands: /thread <id> · /abort · /quit");

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
	prompt: "> ",
});
rl.prompt();

rl.on("line", (line) => {
	const text = line.trim();
	void (async () => {
		try {
			if (text.length === 0) return;
			if (text === "/quit") {
				rl.close();
				return;
			}
			if (text === "/abort") {
				await conn.conversation.abort(rootId, { background: false });
				console.log("[aborted]");
				return;
			}
			if (text.startsWith("/thread ")) {
				threadId = text.slice("/thread ".length).trim();
				conn = connectActor(threadId);
				rootId = (await conn.harness.root()).id;
				await attach();
				console.log(
					`switched to thread ${threadId} (conversation ${rootId})`,
				);
				return;
			}
			const result = await conn.prompt(text, {
				conversationId: rootId,
				requestId: randomUUID(),
				...(running ? { whenBusy: "steer" as const } : {}),
			});
			if (result.status === "unanswered") {
				console.log(`[unanswered: ${result.reason}]`);
			}
		} catch (error) {
			console.log(
				`[error] ${error instanceof Error ? error.message : error}`,
			);
		} finally {
			rl.prompt();
		}
	})();
});

rl.on("close", () => process.exit(0));
