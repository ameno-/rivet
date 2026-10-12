/**
 * Deterministic tests for the `pi_mate_backend_info` custom tool.
 *
 * The tests cover:
 *
 * - the env-var gate: off by default, on only for the documented values,
 *   re-read on every call so a mid-session env var rotation flips it;
 * - the typed-input contract: strict TypeBox schema rejects unknown,
 *   oversized, and malformed arguments (Pi's runtime enforces this
 *   before `execute` runs; we verify the schema shape directly);
 * - the bounded output: the snapshot is byte-capped under
 * `BACKEND_INFO_TOOL_MAX_RESULT_BYTES` and deterministically truncated
 *   when over budget;
 * - redaction: model ids, model lists, API key env var names, agentOS
 *   URLs, sandbox provider secrets, and the cwd never appear in the
 *   text or in the details;
 * - cancellation: an already-aborted signal causes the tool to throw,
 *   so a run that aborts mid-call never wedges;
 * - the gate inside the tool's `execute`: when the env var is unset the
 *   tool returns `isError: true` and the snapshot text is never emitted.
 *
 * No live Engine is required. The tool is exercised by importing it
 * directly, so the test never touches the Pi runtime's Type Compiler.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import {
	BACKEND_INFO_TOOL_MAX_NOTE_LENGTH,
	BACKEND_INFO_TOOL_MAX_RESULT_BYTES,
	BACKEND_INFO_TOOL_MAX_SESSION_ID_LENGTH,
	PI_MATE_BACKEND_INFO_TOOL_ENV,
	PI_MATE_BACKEND_INFO_TOOL_NAME,
	buildBackendInfoSnapshot,
	buildBackendInfoTool,
	readBackendInfoToolEnabled,
	type BackendInfoToolDetails,
} from "../src/backend-info-tool.ts";
import {
	DEFAULT_API_KEY_ENV_VARS,
	DEFAULT_PI_MATE_MODEL,
	DEFAULT_SCOPED_MODELS,
	type PiMateConfig,
} from "../src/config.ts";

const ENV_KEYS = [PI_MATE_BACKEND_INFO_TOOL_ENV] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function fixedConfig(overrides: Partial<PiMateConfig> = {}): PiMateConfig {
	return {
		model: DEFAULT_PI_MATE_MODEL,
		scopedModels: [...DEFAULT_SCOPED_MODELS],
		apiKeyEnvVars: [...DEFAULT_API_KEY_ENV_VARS],
		fauxProofProvider: false,
		rejectLoopbackEndpoint: true,
		sandbox: { name: "none" },
		...overrides,
	};
}

/** Conversation id the API stub reports; the durable conversation is
 * the persisted session, so the snapshot echoes this id. */
const STUB_CONVERSATION_ID = 42;
const STUB_SESSION_ID = "42";

/**
 * Minimal stub for the Pi Durable tool execution API. Only the fields
 * the tool reads are filled in; the rest are typed away.
 */
function executionApiStub(): ToolExecutionApi<BackendInfoToolDetails> {
	return {
		conversationId: STUB_CONVERSATION_ID,
	} as unknown as ToolExecutionApi<BackendInfoToolDetails>;
}

/**
 * Minimal stub for the chord context Pi Durable passes to `execute`.
 * Carries only the call's AbortSignal; structurally satisfies the
 * `Context` shape without importing the chord package.
 */
function contextStub(signal?: AbortSignal): {
	abortSignal: AbortSignal | undefined;
	value: <T>() => T | undefined;
	toString(): string;
} {
	return {
		abortSignal: signal,
		value: <T>() => undefined,
		toString: () => "pi-mate-tool-test-context",
	};
}

describe("readBackendInfoToolEnabled", () => {
	test("is disabled when the env var is unset", () => {
		expect(readBackendInfoToolEnabled({})).toBe(false);
	});

	test("is disabled for any non-boolean-looking value", () => {
		expect(
			readBackendInfoToolEnabled({ [PI_MATE_BACKEND_INFO_TOOL_ENV]: "" }),
		).toBe(false);
		expect(
			readBackendInfoToolEnabled({
				[PI_MATE_BACKEND_INFO_TOOL_ENV]: "0",
			}),
		).toBe(false);
		expect(
			readBackendInfoToolEnabled({
				[PI_MATE_BACKEND_INFO_TOOL_ENV]: "yes",
			}),
		).toBe(false);
		expect(
			readBackendInfoToolEnabled({
				[PI_MATE_BACKEND_INFO_TOOL_ENV]: "True ",
			}),
		).toBe(true);
	});

	test("accepts the documented truthy values case-insensitively", () => {
		expect(
			readBackendInfoToolEnabled({
				[PI_MATE_BACKEND_INFO_TOOL_ENV]: "1",
			}),
		).toBe(true);
		expect(
			readBackendInfoToolEnabled({
				[PI_MATE_BACKEND_INFO_TOOL_ENV]: "true",
			}),
		).toBe(true);
		expect(
			readBackendInfoToolEnabled({
				[PI_MATE_BACKEND_INFO_TOOL_ENV]: "TRUE",
			}),
		).toBe(true);
		expect(
			readBackendInfoToolEnabled({
				[PI_MATE_BACKEND_INFO_TOOL_ENV]: "  1  ",
			}),
		).toBe(true);
	});

	test("reads the live process env when no argument is supplied", () => {
		process.env[PI_MATE_BACKEND_INFO_TOOL_ENV] = "1";
		expect(readBackendInfoToolEnabled()).toBe(true);
		process.env[PI_MATE_BACKEND_INFO_TOOL_ENV] = "0";
		expect(readBackendInfoToolEnabled()).toBe(false);
	});
});

describe("buildBackendInfoSnapshot", () => {
	test("exposes only the documented fields and redacts model identifiers", () => {
		const cfg = fixedConfig({
			model: "anthropic/claude-sonnet-4-6",
			scopedModels: [
				"anthropic/claude-sonnet-4-6",
				"anthropic/claude-opus-4-7",
			],
			apiKeyEnvVars: ["PI_MATE_SECRET_API_KEY"],
		});
		const { text, details } = buildBackendInfoSnapshot({
			config: cfg,
			enabled: true,
			note: "integration-check",
			sessionId: "session-xyz",
		});
		const parsed = JSON.parse(text);
		expect(parsed.kind).toBe("pi_mate_backend_info");
		expect(parsed.sessionId).toBe("session-xyz");
		expect(parsed.modelAllowlistSize).toBe(2);
		expect(parsed.sandboxProviderName).toBe("none");
		expect(parsed.backendInfoToolEnabled).toBe(true);
		expect(parsed.note).toBe("integration-check");
		expect(typeof parsed.generatedAt).toBe("string");

		expect(details.modelAllowlistSize).toBe(2);
		expect(details.sandboxProviderName).toBe("none");
		expect(details.enabled).toBe(true);
		expect(details.truncated).toBe(false);
		expect(details.bytes).toBe(Buffer.byteLength(text));
	});

	test("never echoes the model id, model list, or API key env var name", () => {
		const cfg = fixedConfig({
			model: "anthropic/claude-sonnet-4-6-secret",
			scopedModels: [
				"anthropic/claude-sonnet-4-6-secret",
				"anthropic/claude-opus-secret",
			],
			apiKeyEnvVars: ["PI_MATE_TEST_DO_NOT_LEAK"],
		});
		const { text, details } = buildBackendInfoSnapshot({
			config: cfg,
			enabled: true,
		});
		const dumped = JSON.stringify({ text, details });
		expect(dumped).not.toContain("claude-sonnet-4-6-secret");
		expect(dumped).not.toContain("claude-opus-secret");
		expect(dumped).not.toContain("PI_MATE_TEST_DO_NOT_LEAK");
	});

	test("redacts sandbox provider URLs, digests, and env var overrides", () => {
		const cfg = fixedConfig({
			sandbox: {
				name: "agentos",
				cwd: "/secret/cwd/path",
				software: [
					{
						url: "https://example.test/secret-pkg.tgz",
						digest: "sha256-deadbeef",
					},
				],
				daytonaApiKeyEnvVar: "SECRET_DAYTONA_KEY",
				e2bApiKeyEnvVar: "SECRET_E2B_KEY",
				e2bTemplate: "secret-template",
			},
		});
		const { text, details } = buildBackendInfoSnapshot({
			config: cfg,
			enabled: true,
		});
		const dumped = JSON.stringify({ text, details });
		expect(dumped).not.toContain("secret-pkg");
		expect(dumped).not.toContain("deadbeef");
		expect(dumped).not.toContain("SECRET_DAYTONA_KEY");
		expect(dumped).not.toContain("SECRET_E2B_KEY");
		expect(dumped).not.toContain("secret-template");
		expect(dumped).not.toContain("/secret/cwd/path");
		expect(dumped).not.toContain("example.test");
		expect(details.sandboxProviderName).toBe("agentos");
	});

	test("respects the byte cap and sets the truncated flag deterministically", () => {
		// Force the snapshot to overflow by stuffing in a max-length sessionId.
		const hugeSessionId = "s".repeat(
			BACKEND_INFO_TOOL_MAX_SESSION_ID_LENGTH,
		);
		const cfg = fixedConfig();
		const { text, details, truncated } = buildBackendInfoSnapshot({
			config: cfg,
			enabled: true,
			note: "n".repeat(BACKEND_INFO_TOOL_MAX_NOTE_LENGTH),
			sessionId: hugeSessionId,
		});
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
			BACKEND_INFO_TOOL_MAX_RESULT_BYTES,
		);
		expect(details.bytes).toBe(Buffer.byteLength(text));
		if (details.truncated) {
			expect(truncated).toBe(true);
			expect(text).toContain(`"truncated":true`);
		} else {
			expect(truncated).toBe(false);
		}
	});

	test("deterministically caps a pathologically oversized session id", () => {
		const cfg = fixedConfig();
		const result = buildBackendInfoSnapshot({
			config: cfg,
			enabled: true,
			// A pathological sessionId that would otherwise blow past the
			// per-field cap; the snapshot must still respect the byte cap.
			sessionId: "s".repeat(2_000),
		});
		expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(
			BACKEND_INFO_TOOL_MAX_RESULT_BYTES,
		);
		// The sessionId is clipped to its own cap, so the snapshot may not
		// be truncated at the byte cap; what matters is that no part of
		// the result exceeds the cap.
		expect(result.text.endsWith("}")).toBe(true);
	});

	test("truncates deterministically when the JSON alone overflows the cap", () => {
		// Build a config with a sandbox that has many software entries; the
		// snapshot does NOT echo the URLs, but a config that yields a big
		// enough sandbox summary will overflow.
		const bigSandbox = {
			name: "agentos" as const,
			cwd: undefined,
			software: Array.from({ length: 200 }, (_, i) => ({
				url: `https://example.test/pkg-${i}.tgz`,
			})),
			daytonaApiKeyEnvVar: undefined,
			e2bApiKeyEnvVar: undefined,
			e2bTemplate: undefined,
		};
		const cfg = fixedConfig({ sandbox: bigSandbox });
		// Push a very long note to force the JSON past the byte cap.
		const longNote = "n".repeat(BACKEND_INFO_TOOL_MAX_NOTE_LENGTH);
		const result = buildBackendInfoSnapshot({
			config: cfg,
			enabled: true,
			note: longNote,
			sessionId: "s".repeat(BACKEND_INFO_TOOL_MAX_SESSION_ID_LENGTH),
		});
		expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(
			BACKEND_INFO_TOOL_MAX_RESULT_BYTES,
		);
	});

	test("includes a generatedAt timestamp and treats undefined fields as undefined", () => {
		const { text, details } = buildBackendInfoSnapshot({
			config: fixedConfig(),
			enabled: false,
		});
		const parsed = JSON.parse(text);
		expect(parsed.backendInfoToolEnabled).toBe(false);
		expect(parsed.sessionId).toBeUndefined();
		expect(parsed.note).toBeUndefined();
		expect(details.enabled).toBe(false);
		expect(details.note).toBeUndefined();
		expect(details.sessionId).toBeUndefined();
	});
});

describe("buildBackendInfoTool", () => {
	test("returns a tool with the documented name and description", () => {
		const tool = buildBackendInfoTool(fixedConfig());
		expect(tool.name).toBe(PI_MATE_BACKEND_INFO_TOOL_NAME);
		expect(tool.description.length).toBeGreaterThan(0);
		expect(tool.parameters).toBeDefined();
	});

	test("returns isError=true when the gate env var is unset", async () => {
		const tool = buildBackendInfoTool(fixedConfig());
		// The argument schema is validated by Pi Durable's harness before
		// execute runs. We pass the same shape the harness would pass
		// after validation.
		const result = await tool.execute(
			{},
			executionApiStub(),
			contextStub(),
		);
		expect(result.isError).toBe(true);
		expect(result.content?.[0]?.type).toBe("text");
		const text = (result.content?.[0] as { text: string }).text;
		expect(text).toContain(PI_MATE_BACKEND_INFO_TOOL_NAME);
		expect(text).toContain(PI_MATE_BACKEND_INFO_TOOL_ENV);
		// The disabled response never echoes the snapshot text.
		expect(text).not.toContain("pi_mate_backend_info_disabled");
		expect(text).not.toContain("claude-sonnet");
	});

	test("returns a successful snapshot when the gate env var is set", async () => {
		process.env[PI_MATE_BACKEND_INFO_TOOL_ENV] = "1";
		const tool = buildBackendInfoTool(
			fixedConfig({
				model: "openai/gpt-5",
				scopedModels: ["openai/gpt-5", "openai/gpt-5-mini"],
			}),
		);
		const result = await tool.execute(
			{ note: "ready" },
			executionApiStub(),
			contextStub(),
		);
		expect(result.isError).toBeUndefined();
		const text = (result.content?.[0] as { text: string }).text;
		expect(text).toContain("pi_mate_backend_info");
		expect(text).toContain(`"sessionId":"${STUB_SESSION_ID}"`);
		// modelAllowlistSize is the only model-allowed exposure.
		expect(text).toContain('"modelAllowlistSize":2');
		expect(text).not.toContain("openai/gpt-5");
		expect(text).not.toContain("openai/gpt-5-mini");

		const details = result.details as BackendInfoToolDetails;
		expect(details.enabled).toBe(true);
		expect(details.modelAllowlistSize).toBe(2);
		expect(details.sandboxProviderName).toBe("none");
		expect(details.sessionId).toBe(STUB_SESSION_ID);
		expect(details.note).toBe("ready");
	});

	test("re-reads the env gate inside execute, so a mid-session rotation flips the tool on", async () => {
		// Gate starts off.
		const tool = buildBackendInfoTool(fixedConfig());
		const disabled = await tool.execute(
			{},
			executionApiStub(),
			contextStub(),
		);
		expect(disabled.isError).toBe(true);

		// Operator flips the gate.
		process.env[PI_MATE_BACKEND_INFO_TOOL_ENV] = "true";
		const enabled = await tool.execute(
			{},
			executionApiStub(),
			contextStub(),
		);
		expect(enabled.isError).toBeUndefined();
		const text = (enabled.content?.[0] as { text: string }).text;
		expect(text).toContain("pi_mate_backend_info");
	});

	test("throws when the call's AbortSignal is already aborted", async () => {
		process.env[PI_MATE_BACKEND_INFO_TOOL_ENV] = "1";
		const tool = buildBackendInfoTool(fixedConfig());
		const controller = new AbortController();
		controller.abort(new Error("test-abort"));
		await expect(
			tool.execute(
				{},
				executionApiStub(),
				contextStub(controller.signal),
			),
		).rejects.toThrow(/aborted/);
	});

	test("completes normally when the AbortSignal is not aborted", async () => {
		process.env[PI_MATE_BACKEND_INFO_TOOL_ENV] = "1";
		const tool = buildBackendInfoTool(fixedConfig());
		const controller = new AbortController();
		const result = await tool.execute(
			{},
			executionApiStub(),
			contextStub(controller.signal),
		);
		expect(result.isError).toBeUndefined();
	});

	test("the disabled response does not include the snapshot text", async () => {
		const tool = buildBackendInfoTool(
			fixedConfig({
				model: "openai/gpt-5-secret",
				scopedModels: ["openai/gpt-5-secret"],
				apiKeyEnvVars: ["PI_MATE_DO_NOT_LEAK"],
			}),
		);
		const result = await tool.execute(
			{},
			executionApiStub(),
			contextStub(),
		);
		const dumped = JSON.stringify(result);
		expect(dumped).not.toContain("gpt-5-secret");
		expect(dumped).not.toContain("PI_MATE_DO_NOT_LEAK");
	});
});

describe("credential hygiene of the buildBackendInfoTool registry wiring", () => {
	test("the tool object never carries credentials or env-var names", () => {
		const cfg = fixedConfig({
			model: "anthropic/claude-sonnet-4-6",
			scopedModels: ["anthropic/claude-sonnet-4-6"],
			apiKeyEnvVars: ["PI_MATE_DO_NOT_LEAK_KEY"],
			sandbox: {
				name: "daytona",
				daytonaApiKeyEnvVar: "PI_MATE_DO_NOT_LEAK_DAYTONA",
			},
		});
		const tool = buildBackendInfoTool(cfg);
		const dumped = JSON.stringify(tool);
		expect(dumped).not.toContain("PI_MATE_DO_NOT_LEAK_KEY");
		expect(dumped).not.toContain("PI_MATE_DO_NOT_LEAK_DAYTONA");
		// The config object is reachable through the tool's closure;
		// `JSON.stringify` does not walk closures, so this is a smoke test.
		expect(typeof tool.execute).toBe("function");
	});

	test("the snapshot text never contains a string that looks like a credential", () => {
		process.env[PI_MATE_BACKEND_INFO_TOOL_ENV] = "1";
		const cfg = fixedConfig({
			apiKeyEnvVars: ["PI_MATE_DO_NOT_LEAK_KEY"],
			sandbox: {
				name: "e2b",
				e2bApiKeyEnvVar: "PI_MATE_DO_NOT_LEAK_E2B",
			},
		});
		const { text, details } = buildBackendInfoSnapshot({
			config: cfg,
			enabled: true,
			sessionId: "session-1",
		});
		const dumped = JSON.stringify({ text, details });
		expect(dumped).not.toContain("PI_MATE_DO_NOT_LEAK_KEY");
		expect(dumped).not.toContain("PI_MATE_DO_NOT_LEAK_E2B");
	});

	test("a snapshot whose session id exceeds the cap is still redacted", () => {
		const cfg = fixedConfig({
			apiKeyEnvVars: ["PI_MATE_DO_NOT_LEAK_KEY"],
		});
		const { text, details } = buildBackendInfoSnapshot({
			config: cfg,
			enabled: true,
			sessionId: `session-${"x".repeat(500)}`,
		});
		const dumped = JSON.stringify({ text, details });
		expect(dumped).not.toContain("PI_MATE_DO_NOT_LEAK_KEY");
		expect(dumped.length).toBeLessThanOrEqual(
			BACKEND_INFO_TOOL_MAX_RESULT_BYTES,
		);
	});
});

describe("schema strictness", () => {
	test("the schema rejects additional unknown properties", () => {
		// Pi's runtime compiles the schema and runs TypeCompiler.Check
		// before execute. We import the tool object and verify the
		// schema structure directly. The runtime check is the line of
		// defence; this test guards the schema shape.
		const tool = buildBackendInfoTool(fixedConfig());
		const schema = tool.parameters as unknown as {
			type: string;
			additionalProperties?: unknown;
			properties?: Record<string, unknown>;
		};
		expect(schema.type).toBe("object");
		expect(schema.additionalProperties).toBe(false);
		expect(schema.properties?.note).toBeDefined();
	});

	test("the note schema caps the string length", () => {
		const tool = buildBackendInfoTool(fixedConfig());
		const schema = tool.parameters as unknown as {
			properties?: {
				note?: {
					maxLength?: number;
					minLength?: number;
					type?: string;
				};
			};
		};
		expect(schema.properties?.note?.maxLength).toBe(
			BACKEND_INFO_TOOL_MAX_NOTE_LENGTH,
		);
		expect(schema.properties?.note?.minLength).toBe(1);
		expect(schema.properties?.note?.type).toBe("string");
	});

	test("snapshots stay under the byte cap across a range of inputs", () => {
		const cfg = fixedConfig({
			scopedModels: [
				"openai/gpt-5",
				"anthropic/claude-opus",
				"google/gemini",
			],
			apiKeyEnvVars: ["PI_MATE_KEY_A", "PI_MATE_KEY_B"],
		});
		const inputs = [
			{ enabled: true, note: "ok", sessionId: "session-1" },
			{ enabled: true, note: undefined, sessionId: undefined },
			{ enabled: false, note: undefined, sessionId: "session-x" },
		];
		for (const input of inputs) {
			const { text } = buildBackendInfoSnapshot({
				config: cfg,
				...input,
			});
			expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
				BACKEND_INFO_TOOL_MAX_RESULT_BYTES,
			);
		}
	});
});

describe("observability of the cancellation path", () => {
	test("aborted signal causes the execute to throw before any work", async () => {
		process.env[PI_MATE_BACKEND_INFO_TOOL_ENV] = "1";
		const tool = buildBackendInfoTool(fixedConfig());
		const controller = new AbortController();
		// Abort and immediately invoke. The tool should throw with a
		// descriptive message and never produce content.
		controller.abort(new Error("user-cancelled"));
		await expect(
			tool.execute(
				{},
				executionApiStub(),
				contextStub(controller.signal),
			),
		).rejects.toThrow(/aborted/);
	});
});
