/**
 * Tests for the public type boundary.
 *
 * These tests are the runtime counterpart to the `import type` contract in
 * `src/client-types.ts`. The type itself is enforced by `tsc`; the runtime
 * here confirms that:
 *
 * 1. The exported `PiMateActorName` constant matches the actor name the
 *    registry actually exposes, so an external integrator that uses
 *    `client[PI_MATE_ACTOR_NAME]` does not typo its way into a missing
 *    accessor.
 * 2. `PiMateClientErrorImpl` is constructible from every documented error
 *    variant and round-trips the `kind` discriminator, so the typed adapter
 *    can wrap protocol failures without losing the category.
 * 3. The `PiMateRegistry` type and the runtime registry agree on the actor
 *    name. This is the core invariant: a `createClient<typeof registry>`
 *    call outside this package must target the same actor name as the
 *    registry this package ships.
 */

import { describe, expect, test } from "vitest";
import { FIRST_MATE_ACTOR_NAME, buildPiMateRegistry } from "../src/actors.ts";
import {
	PiMateClientErrorImpl,
	type PiMateActorName,
} from "../src/client-types.ts";

function fixedConfig() {
	return {
		model: "anthropic/claude-sonnet-4-6",
		scopedModels: ["anthropic/claude-sonnet-4-6"],
		apiKeyEnvVars: ["PI_MATE_ANTHROPIC_API_KEY"],
		fauxProofProvider: false,
		rejectLoopbackEndpoint: true,
		sandbox: { name: "none" as const },
	};
}

describe("public type boundary", () => {
	test("the actor name exported from the type boundary matches the registry's actor", () => {
		// The type literal must equal the constant the registry wires up.
		// If the registry ever renames the actor, this test (and any external
		// `client[PiMateActorName]`) breaks loudly.
		const actorName: PiMateActorName = FIRST_MATE_ACTOR_NAME;
		expect(actorName).toBe("firstMate");

		const registry = buildPiMateRegistry(fixedConfig());
		const actorNames = Object.keys(registry.parseConfig().use);
		expect(actorNames).toContain(actorName);
	});

	test("PiMateClientErrorImpl round-trips every documented kind", () => {
		const variants = [
			"unavailable",
			"rejected",
			"transport",
			"protocol",
		] as const;
		for (const kind of variants) {
			const error = new PiMateClientErrorImpl(kind, `${kind} message`);
			expect(error.kind).toBe(kind);
			expect(error.message).toBe(`${kind} message`);
			expect(error.name).toBe("PiMateClientError");
			expect(error).toBeInstanceOf(Error);
		}
	});

	test("PiMateClientErrorImpl is throwable like a normal error", () => {
		expect(() => {
			throw new PiMateClientErrorImpl("transport", "boom");
		}).toThrow(PiMateClientErrorImpl);
	});
});
