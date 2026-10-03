/**
 * Deterministic tests for the Goal Charter validator.
 *
 * The validator is the first line of defence on the operator surface.
 * Every malformed input the operator could plausibly receive must be
 * rejected with a stable, well-typed error before any office or storage
 * runs. These tests pin the validator's contract field-by-field and
 * keep regression coverage for the unsafe-id and path-traversal
 * rejections that the receipt store later relies on.
 */

import { describe, expect, it } from "vitest";
import {
	CharterValidationError,
	isCharterValidationError,
	validateGoalCharter,
} from "../src/charter-validation.ts";

function validCharter(): Record<string, unknown> {
	return {
		id: "demo-1",
		title: "Demonstrate the validator",
		objective: "Show the deterministic contract",
		acceptanceCriteria: ["Every field validates"],
		constraints: ["No network"],
		maxIterations: 1,
	};
}

describe("validateGoalCharter", () => {
	describe("valid input", () => {
		it("accepts a complete charter and returns a defensive copy", () => {
			const input = validCharter();
			const result = validateGoalCharter(input);
			expect(result.id).toBe("demo-1");
			expect(result.title).toBe("Demonstrate the validator");
			expect(result.objective).toBe("Show the deterministic contract");
			expect(result.acceptanceCriteria).toEqual([
				"Every field validates",
			]);
			expect(result.constraints).toEqual(["No network"]);
			expect(result.maxIterations).toBe(1);
			// Defensive copies: mutating the result must not influence the
			// original input.
			result.acceptanceCriteria.push("hacked");
			expect(input.acceptanceCriteria).toEqual(["Every field validates"]);
			expect(result.constraints).not.toBe(input.constraints);
		});

		it("accepts the maximum-length id", () => {
			const result = validateGoalCharter({
				...validCharter(),
				id: "a".repeat(128),
			});
			expect(result.id).toHaveLength(128);
		});

		it("accepts the minimal field set (constraints empty, maxIterations 1)", () => {
			const result = validateGoalCharter({
				...validCharter(),
				constraints: [],
			});
			expect(result.constraints).toEqual([]);
			expect(result.maxIterations).toBe(1);
		});
	});

	describe("non-object input", () => {
		it.each([
			["null", null],
			["undefined", undefined],
			["number", 42],
			["string", "not a charter"],
			["boolean", true],
			["empty array", []],
			["array of objects", [{ id: "x" }]],
			["class instance", new (class Charter {})()],
		])("rejects %s with a clear message", (_label, value) => {
			expect(() => validateGoalCharter(value)).toThrow(
				CharterValidationError,
			);
			expect(() => validateGoalCharter(value)).toThrow(
				/Charter must be a JSON object/,
			);
		});

		it("rejects an empty object with the first missing field", () => {
			expect(() => validateGoalCharter({})).toThrow(
				/Charter id must be a string/,
			);
		});
	});

	describe("required string fields", () => {
		it("rejects a missing id", () => {
			const input = validCharter();
			delete (input as Record<string, unknown>).id;
			expect(() => validateGoalCharter(input)).toThrow(
				/Charter id must be a string/,
			);
		});

		it("rejects an empty id", () => {
			expect(() =>
				validateGoalCharter({ ...validCharter(), id: "" }),
			).toThrow(/Charter id must not be empty/);
		});

		it("rejects a non-string id", () => {
			expect(() =>
				validateGoalCharter({ ...validCharter(), id: 42 }),
			).toThrow(/Charter id must be a string/);
		});

		it("rejects a missing title", () => {
			const input = validCharter();
			delete (input as Record<string, unknown>).title;
			expect(() => validateGoalCharter(input)).toThrow(
				/Charter title must be a string/,
			);
		});

		it("rejects an empty title", () => {
			expect(() =>
				validateGoalCharter({ ...validCharter(), title: "" }),
			).toThrow(/Charter title must not be empty/);
		});

		it("rejects a missing objective", () => {
			const input = validCharter();
			delete (input as Record<string, unknown>).objective;
			expect(() => validateGoalCharter(input)).toThrow(
				/Charter objective must be a string/,
			);
		});

		it("rejects an empty objective", () => {
			expect(() =>
				validateGoalCharter({ ...validCharter(), objective: "" }),
			).toThrow(/Charter objective must not be empty/);
		});
	});

	describe("acceptanceCriteria and constraints", () => {
		it("rejects a missing acceptanceCriteria", () => {
			const input = validCharter();
			delete (input as Record<string, unknown>).acceptanceCriteria;
			expect(() => validateGoalCharter(input)).toThrow(
				/Charter acceptanceCriteria must be an array of strings/,
			);
		});

		it("rejects a non-array acceptanceCriteria", () => {
			expect(() =>
				validateGoalCharter({
					...validCharter(),
					acceptanceCriteria: "Every field validates",
				}),
			).toThrow(/Charter acceptanceCriteria must be an array of strings/);
		});

		it("rejects an empty acceptanceCriteria array", () => {
			expect(() =>
				validateGoalCharter({
					...validCharter(),
					acceptanceCriteria: [],
				}),
			).toThrow(/acceptanceCriteria must contain at least one entry/);
		});

		it("rejects a non-string entry inside acceptanceCriteria", () => {
			expect(() =>
				validateGoalCharter({
					...validCharter(),
					acceptanceCriteria: [1, "ok"],
				}),
			).toThrow(/acceptanceCriteria\[0\] must be a string/);
		});

		it("rejects an empty string entry inside acceptanceCriteria", () => {
			expect(() =>
				validateGoalCharter({
					...validCharter(),
					acceptanceCriteria: ["", "ok"],
				}),
			).toThrow(/acceptanceCriteria\[0\] must not be empty/);
		});

		it("rejects a non-array constraints value", () => {
			expect(() =>
				validateGoalCharter({ ...validCharter(), constraints: "no" }),
			).toThrow(/Charter constraints must be an array of strings/);
		});

		it("rejects an empty string inside constraints", () => {
			expect(() =>
				validateGoalCharter({
					...validCharter(),
					constraints: ["", "ok"],
				}),
			).toThrow(/constraints\[0\] must not be empty/);
		});

		it("accepts an empty constraints array", () => {
			const result = validateGoalCharter({
				...validCharter(),
				constraints: [],
			});
			expect(result.constraints).toEqual([]);
		});
	});

	describe("maxIterations", () => {
		it("rejects a missing maxIterations", () => {
			const input = validCharter();
			delete (input as Record<string, unknown>).maxIterations;
			expect(() => validateGoalCharter(input)).toThrow(
				/Charter maxIterations must be an integer/,
			);
		});

		it("rejects a non-integer maxIterations", () => {
			expect(() =>
				validateGoalCharter({ ...validCharter(), maxIterations: 1.5 }),
			).toThrow(/Charter maxIterations must be an integer/);
		});

		it("rejects a string maxIterations", () => {
			expect(() =>
				validateGoalCharter({ ...validCharter(), maxIterations: "3" }),
			).toThrow(/Charter maxIterations must be an integer/);
		});

		it("rejects a zero maxIterations", () => {
			expect(() =>
				validateGoalCharter({ ...validCharter(), maxIterations: 0 }),
			).toThrow(/Charter maxIterations must be at least 1/);
		});

		it("rejects a negative maxIterations", () => {
			expect(() =>
				validateGoalCharter({ ...validCharter(), maxIterations: -2 }),
			).toThrow(/Charter maxIterations must be at least 1/);
		});

		it("rejects NaN and Infinity", () => {
			expect(() =>
				validateGoalCharter({
					...validCharter(),
					maxIterations: Number.NaN,
				}),
			).toThrow(/Charter maxIterations must be an integer/);
			expect(() =>
				validateGoalCharter({
					...validCharter(),
					maxIterations: Number.POSITIVE_INFINITY,
				}),
			).toThrow(/Charter maxIterations must be an integer/);
		});
	});

	describe("id safety", () => {
		it.each([
			["path traversal", "../etc/passwd"],
			["absolute path", "/etc/passwd"],
			["backslashes", "a\\b"],
			["shell injection", "a;rm -rf /"],
			["spaces", "hello world"],
			["leading dash", "-abc"],
			["leading dot", ".abc"],
			["newline", "abc\nxyz"],
			["null byte", "abc\0xyz"],
			["overlong id (129 chars)", "a".repeat(129)],
			["non-ascii", "café"],
		])("rejects an unsafe id (%s)", (_label, id) => {
			expect(() =>
				validateGoalCharter({ ...validCharter(), id }),
			).toThrow(/Charter id must match/);
		});

		it.each([
			["letters only", "demo"],
			["digits only", "123"],
			["dotted", "demo.alpha"],
			["underscored", "demo_alpha"],
			["dashes", "demo-alpha-1"],
			["128 chars (max length)", "a".repeat(128)],
			["single char", "x"],
		])("accepts a safe id (%s)", (_label, id) => {
			expect(() =>
				validateGoalCharter({ ...validCharter(), id }),
			).not.toThrow();
		});
	});

	describe("unknown / malformed fields", () => {
		it("ignores unknown extra fields without erroring", () => {
			// The current validator is permissive about unknown top-level
			// fields: it strips them silently. Pin that contract here so
			// any future tightening is observable in this test.
			const result = validateGoalCharter({
				...validCharter(),
				extraField: "should be ignored",
				anotherExtra: 42,
			});
			expect(result).not.toHaveProperty("extraField");
			expect(result).not.toHaveProperty("anotherExtra");
		});

		it("rejects when required field is replaced by a wrong primitive type", () => {
			// An array where a string is required is one of the common
			// hand-edit mistakes; the validator must reject it.
			expect(() =>
				validateGoalCharter({
					...validCharter(),
					objective: ["array", "not", "allowed"],
				}),
			).toThrow(/Charter objective must be a string/);
		});

		it("rejects when acceptanceCriteria is an object (not an array)", () => {
			expect(() =>
				validateGoalCharter({
					...validCharter(),
					acceptanceCriteria: { 0: "Every field validates" },
				}),
			).toThrow(/Charter acceptanceCriteria must be an array of strings/);
		});
	});

	describe("error type narrowing", () => {
		it("tags every validation failure with code 'invalid_charter'", () => {
			try {
				validateGoalCharter(null);
				throw new Error("expected throw");
			} catch (error) {
				expect(error).toBeInstanceOf(CharterValidationError);
				expect(isCharterValidationError(error)).toBe(true);
				expect((error as CharterValidationError).code).toBe(
					"invalid_charter",
				);
			}
		});

		it("isCharterValidationError returns false for non-charter errors", () => {
			expect(isCharterValidationError(new Error("other"))).toBe(false);
			expect(isCharterValidationError("a string")).toBe(false);
			expect(isCharterValidationError(null)).toBe(false);
		});
	});
});
