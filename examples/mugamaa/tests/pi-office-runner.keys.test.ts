import { describe, expect, it } from "vitest";
import {
	auditActorKey,
	planningActorKey,
	sanitizeKeySegment,
	unsanitizeKeySegment,
	worksActorKey,
} from "../src/pi-office-runner.ts";
import type { ModelRoute } from "../src/types.ts";

/**
 * Deterministic actor-key tests for the Pi Office bridge.
 *
 * The keys are the only contract between Mugamaa and the Pi
 * registry / application wiring layer: a misnamed actor key would
 * open the wrong session. These tests pin the exact shape of the
 * keys and the round-trip behaviour of the reversible segment
 * encoder.
 */

const route: ModelRoute = {
	provider: "minimax-direct",
	model: "minimax-m3",
	thinking: "low",
	tier: "fallback",
};

const opencodeRoute: ModelRoute = {
	provider: "opencode-go",
	model: "grok-4.7",
	thinking: "medium",
	tier: "open",
};

describe("deterministic actor keys", () => {
	it("produces the exact <case-id>/<iteration>/planning key", () => {
		expect(planningActorKey("alpha", 3)).toBe("alpha/3/planning");
	});

	it("produces the exact <case-id>/<iteration>/works key", () => {
		expect(worksActorKey("alpha", 3)).toBe("alpha/3/works");
	});

	it("produces the exact <case-id>/<iteration>/audit/<provider>/<model> key for two distinct audit routes", () => {
		expect(auditActorKey("alpha", 3, opencodeRoute)).toBe(
			"alpha/3/audit/opencode-go/grok-4.7",
		);
		expect(auditActorKey("alpha", 3, route)).toBe(
			"alpha/3/audit/minimax-direct/minimax-m3",
		);
	});

	it("sanitizes key segments reversibly and deterministically", () => {
		// Sanitization must not lose information: any segment decoded
		// back from a key must match the input byte-for-byte so the
		// registry / application wiring can recover the original
		// segments without ambiguity.
		const original = "case/with slashes-and%percent";
		const sanitized = sanitizeKeySegment(original);
		expect(sanitized).not.toContain("/");
		expect(unsanitizeKeySegment(sanitized)).toBe(original);
		expect(sanitizeKeySegment(original)).toBe(sanitized); // deterministic
	});
});
