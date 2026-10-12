/**
 * Typed client round-trip against the running Pi Mate service.
 *
 * Connects to a running Pi Mate service, resolves the first-mate actor
 * for a fixed owner scope and project id, opens the root conversation,
 * and reads the conversation's resolved agent. This is the typed client
 * surface that Centaur (or any integrator) will use once the service is
 * deployed.
 *
 * Usage:
 *
 *   RIVET_ENDPOINT=http://127.0.0.1:6423 \
 *     pnpm --filter example-pi-mate client
 *
 * The script never sends a prompt and never reads credentials. It exists
 * to validate that the registry and the typed client agree on the actor
 * name and key shape.
 */

import { createClient } from "rivetkit/client";
import { buildPiMateRegistry, FIRST_MATE_ACTOR_NAME } from "../src/actors.ts";
import { firstMateActorKey } from "../src/config.ts";

const ownerScope = process.env.PI_MATE_OWNER_SCOPE ?? "demo-owner";
const projectId = process.env.PI_MATE_PROJECT_ID ?? "demo-project";
// The thread segment partitions conversations (ADR-0002): a different thread
// is a different actor with a different conversation history.
const threadId = process.env.PI_MATE_THREAD_ID ?? "demo-thread";
const endpoint = process.env.RIVET_ENDPOINT ?? "http://127.0.0.1:6423";

async function main(): Promise<void> {
	const registry = buildPiMateRegistry();
	const client = createClient<typeof registry>({ endpoint });
	try {
		const key = firstMateActorKey({ ownerScope, projectId, threadId });
		const handle = client[FIRST_MATE_ACTOR_NAME].getOrCreate([...key]);
		// `harness.root` is part of the inherited `pi()` action set: it
		// resolves (creating on first use) the actor's root conversation.
		// Its presence confirms the typed client picks up the Pi
		// integration, and `conversation.agent` reads the conversation's
		// resolved agent (model, tools, sections) without sending a
		// prompt.
		const root = await handle.harness.root();
		const agent = await handle.conversation.agent(root.id);
		console.log(
			JSON.stringify({
				kind: "pi_mate_client_ok",
				endpoint,
				actor: FIRST_MATE_ACTOR_NAME,
				key: [...key],
				conversationId: root.id,
				model: agent.model,
				toolCount: agent.tools.length,
				extensionCount: agent.extensions.length,
			}),
		);
	} finally {
		await client.dispose();
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	await main();
}

export { main as runClient };
