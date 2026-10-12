import { describe, expect, test } from "vitest";
import {
	PI_MATE_TOOLS_EXTENSION_NAME,
	buildPiMateRegistry,
	buildPiMateCustomTools,
	FIRST_MATE_ACTOR_NAME,
} from "../src/actors.ts";
import { loadPiMateConfig } from "../src/config.ts";
import { PI_MATE_BACKEND_INFO_TOOL_NAME } from "../src/backend-info-tool.ts";

describe("Pi integration surface", () => {
	/** RivetKit flattens nested action objects to dotted names on the
	 * client; the parsed actor config keeps the groups nested, so the
	 * test flattens the same way before asserting. */
	function flattenedActionNames(actor: {
		config: { actions: Record<string, unknown> };
	}): string[] {
		const out: string[] = [];
		for (const [group, members] of Object.entries(actor.config.actions)) {
			if (typeof members === "function") {
				out.push(group);
			} else if (members !== null && typeof members === "object") {
				for (const name of Object.keys(members)) {
					out.push(`${group}.${name}`);
				}
			}
		}
		return out;
	}

	test("the first-mate actor inherits the full Pi action set", () => {
		const registry = buildPiMateRegistry();
		const cfg = registry.parseConfig();
		const actor = cfg.use[FIRST_MATE_ACTOR_NAME];
		const actions = flattenedActionNames(actor);
		// Each of these is part of the @rivet-dev/pi 0.5.x surface:
		// `prompt` is the one convenience action; the rest are Pi
		// Durable's harness/conversation/submission methods under
		// dotted namespaces. This is the public contract the
		// architecture record cites.
		const expected = [
			"prompt",
			"harness.root",
			"harness.conversation",
			"harness.submission",
			"harness.abortSubmission",
			"harness.waitForIdle",
			"harness.inspect",
			"conversation.configure",
			"conversation.compact",
			"conversation.entries",
			"conversation.abort",
			"conversation.watchEvents",
			"conversation.unwatchEvents",
			"conversation.watch",
			"conversation.waitForIdle",
			"submission.status",
			"submission.wait",
			"submission.abort",
		];
		for (const action of expected) {
			expect(
				actions,
				`expected Pi action ${action} to be present`,
			).toContain(action);
		}
	});

	test("steering and follow-up are prompt whenBusy modes, not actions", () => {
		const registry = buildPiMateRegistry();
		const cfg = registry.parseConfig();
		const actor = cfg.use[FIRST_MATE_ACTOR_NAME];
		const actions = flattenedActionNames(actor);
		// 0.1.x exposed `steer`/`followUp`/`setModel` as flat actions;
		// 0.5.x folds them into `prompt({ whenBusy })` and
		// `conversation.configure`. The flat names must not linger as
		// dead surface.
		for (const gone of [
			"steer",
			"followUp",
			"setModel",
			"getSession",
			"getMessages",
		]) {
			expect(
				actions,
				`legacy Pi action ${gone} must be absent`,
			).not.toContain(gone);
		}
	});

	test("the first-mate actor broadcasts the native Pi watch channels", () => {
		const registry = buildPiMateRegistry();
		const cfg = registry.parseConfig();
		const actor = cfg.use[FIRST_MATE_ACTOR_NAME];
		const events = Object.keys(actor.config.events ?? {});
		for (const channel of [
			"pi.events",
			"pi.view",
			"pi.taskGraph",
			"pi.doc",
		]) {
			expect(
				events,
				`expected Pi channel ${channel} to be present`,
			).toContain(channel);
		}
	});

	test("the registry installs the pi_mate_backend_info tool in the harness extension registry", () => {
		// `pi()` requires a Pi Durable extension registry and installs
		// the Mate's tools through an extension. The wiring is verified
		// through the single helper the registry itself consumes. A full
		// end-to-end verification (live Engine, model calling the tool)
		// belongs to the live proof harness.
		const tools = buildPiMateCustomTools(loadPiMateConfig());
		expect(tools.map((tool) => tool.name)).toEqual([
			PI_MATE_BACKEND_INFO_TOOL_NAME,
		]);
		const tool = tools.find(
			(tool) => tool.name === PI_MATE_BACKEND_INFO_TOOL_NAME,
		);
		expect(tool?.description.length).toBeGreaterThan(0);
		expect(typeof tool?.execute).toBe("function");
		// The registry must still parse with the tool wired in.
		expect(() => buildPiMateRegistry().parseConfig()).not.toThrow();
	});

	test("the extension name is stable for conversation-level selection", () => {
		expect(PI_MATE_TOOLS_EXTENSION_NAME).toBe("pi-mate-tools");
	});
});
