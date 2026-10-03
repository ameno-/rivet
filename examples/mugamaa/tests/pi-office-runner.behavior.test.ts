import { describe, expect, it } from "vitest";
import { ModelCapacityError } from "../src/model-policy.ts";
import type { PiOfficeActorResolver } from "../src/pi-office-runner.ts";
import {
	auditActorKey,
	createPiOfficeRunner,
	planningActorKey,
	worksActorKey,
} from "../src/pi-office-runner.ts";
import type {
	AuditInput,
	AuditVerdict,
	ModelRoute,
	PlanningInput,
	ProductArtifact,
	WorkOrder,
	WorksInput,
} from "../src/types.ts";
import { FakeHandle, recordingResolver } from "./pi-office-runner.fakes.ts";

/**
 * Behavior tests for `createPiOfficeRunner`.
 *
 * Every Pi Office bridge call is shaped into a deterministic
 * four-action sequence (`setModel` → `setThinkingLevel` → `prompt` →
 * `getLastAssistantText`), never retried, and parsed through the
 * strict Mugamaa parsers. The fake handles substitute for real Pi
 * actors so no actor is opened, no Pi session is started, and no
 * network call is made.
 */

function planBody(): string {
	return JSON.stringify({
		summary: "plan",
		tasks: ["t"],
		successConditions: ["c"],
	});
}

function workBody(): string {
	return JSON.stringify({
		summary: "artifact",
		body: "b",
		evidence: ["e"],
	});
}

function auditBody(): string {
	return JSON.stringify({
		decision: "pass",
		rationale: "ok",
		findings: [],
	});
}

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

const planning: PlanningInput = {
	charter: {
		id: "pi-bridge-case",
		title: "Pi Office bridge",
		objective: "Verify the Pi Office bridge is deterministic and strict",
		acceptanceCriteria: ["Strict parsers are honoured"],
		constraints: [],
		maxIterations: 1,
	},
	iteration: 2,
	previousVerdicts: [],
};

function worksInput(): WorksInput {
	return {
		...planning,
		workOrder: {
			summary: "do work",
			tasks: ["t"],
			successConditions: ["c"],
		},
	};
}

function auditInput(): AuditInput {
	return {
		charter: planning.charter,
		iteration: planning.iteration,
		workOrder: {
			summary: "do work",
			tasks: ["t"],
			successConditions: ["c"],
		},
		artifact: { summary: "s", body: "b", evidence: ["e"] },
	};
}

describe("createPiOfficeRunner action sequence", () => {
	it("drives setModel → setThinkingLevel → prompt → getLastAssistantText in order on planning", async () => {
		const { resolver, handles } = recordingResolver((key) =>
			key.endsWith("/planning") ? planBody() : undefined,
		);
		const runner = createPiOfficeRunner({ resolveActor: resolver });
		await runner.plan(planning, route);
		const handle = handles.get(
			planningActorKey(planning.charter.id, planning.iteration),
		);
		expect(handle?.calls.map((call) => call.kind)).toEqual([
			"setModel",
			"setThinkingLevel",
			"prompt",
			"getLastAssistantText",
		]);
		expect(handle?.calls[0]).toMatchObject({
			kind: "setModel",
			provider: route.provider,
			modelId: route.model,
		});
		expect(handle?.calls[1]).toMatchObject({
			kind: "setThinkingLevel",
			level: route.thinking,
		});
	});

	it("propagates the route's provider, model, and thinking on works verbatim", async () => {
		const { resolver, handles } = recordingResolver((key) =>
			key.endsWith("/works") ? workBody() : undefined,
		);
		const runner = createPiOfficeRunner({ resolveActor: resolver });
		const input = worksInput();
		await runner.work(input, opencodeRoute);
		const handle = handles.get(
			worksActorKey(input.charter.id, input.iteration),
		);
		expect(handle?.calls.map((call) => call.kind)).toEqual([
			"setModel",
			"setThinkingLevel",
			"prompt",
			"getLastAssistantText",
		]);
		expect(handle?.calls[0]).toMatchObject({
			kind: "setModel",
			provider: "opencode-go",
			modelId: "grok-4.7",
		});
		expect(handle?.calls[1]).toMatchObject({
			kind: "setThinkingLevel",
			level: "medium",
		});
	});

	it("propagates the route's provider, model, and thinking on audit verbatim and uses the audit actor key", async () => {
		const { resolver, handles } = recordingResolver((key) =>
			key.includes("/audit/") ? auditBody() : undefined,
		);
		const runner = createPiOfficeRunner({ resolveActor: resolver });
		const input = auditInput();
		await runner.audit(input, opencodeRoute);
		const handle = handles.get(
			auditActorKey(input.charter.id, input.iteration, opencodeRoute),
		);
		expect(handle?.calls.map((call) => call.kind)).toEqual([
			"setModel",
			"setThinkingLevel",
			"prompt",
			"getLastAssistantText",
		]);
		expect(handle?.calls[0]).toMatchObject({
			kind: "setModel",
			provider: "opencode-go",
			modelId: "grok-4.7",
		});
		expect(handle?.calls[1]).toMatchObject({
			kind: "setThinkingLevel",
			level: "medium",
		});
	});
});

describe("createPiOfficeRunner strict output acceptance and rejection", () => {
	it("accepts a clean WorkOrder response from planning", async () => {
		const order: WorkOrder = {
			summary: "plan",
			tasks: ["t"],
			successConditions: ["c"],
		};
		const { resolver, handles } = recordingResolver();
		handles.set(
			planningActorKey(planning.charter.id, planning.iteration),
			new FakeHandle({
				textOverride: () => JSON.stringify(order),
			}),
		);
		const runner = createPiOfficeRunner({ resolveActor: resolver });
		const parsed = await runner.plan(planning, route);
		expect(parsed).toEqual(order);
	});

	it("rejects malformed planning output without retrying", async () => {
		const handle = new FakeHandle({ textOverride: () => "not json" });
		const resolver: PiOfficeActorResolver = () => handle;
		const runner = createPiOfficeRunner({ resolveActor: resolver });
		await expect(runner.plan(planning, route)).rejects.toThrow(
			/Office output rejected/,
		);
		// Exactly one prompt attempt: no automatic retry.
		const promptCalls = handle.calls.filter(
			(call) => call.kind === "prompt",
		);
		expect(promptCalls).toHaveLength(1);
	});

	it("rejects an invalid audit decision enum and stops after one attempt", async () => {
		const handle = new FakeHandle({
			textOverride: () =>
				JSON.stringify({
					decision: "approve",
					rationale: "r",
					findings: [],
				}),
		});
		const resolver: PiOfficeActorResolver = () => handle;
		const runner = createPiOfficeRunner({ resolveActor: resolver });
		await expect(runner.audit(auditInput(), opencodeRoute)).rejects.toThrow(
			/Office output rejected/,
		);
		const promptCalls = handle.calls.filter(
			(call) => call.kind === "prompt",
		);
		expect(promptCalls).toHaveLength(1);
	});

	it("accepts a clean ProductArtifact from works", async () => {
		const artifact: ProductArtifact = {
			summary: "artifact",
			body: "b",
			evidence: ["e"],
		};
		const { resolver, handles } = recordingResolver();
		handles.set(
			worksActorKey(planning.charter.id, planning.iteration),
			new FakeHandle({
				textOverride: () => JSON.stringify(artifact),
			}),
		);
		const runner = createPiOfficeRunner({ resolveActor: resolver });
		const parsed = await runner.work(worksInput(), opencodeRoute);
		expect(parsed).toEqual(artifact);
	});

	it("accepts a clean AuditVerdict from audit", async () => {
		const verdict: AuditVerdict = {
			decision: "pass",
			rationale: "ok",
			findings: [],
		};
		const { resolver, handles } = recordingResolver();
		handles.set(
			auditActorKey(
				planning.charter.id,
				planning.iteration,
				opencodeRoute,
			),
			new FakeHandle({ textOverride: () => JSON.stringify(verdict) }),
		);
		const runner = createPiOfficeRunner({ resolveActor: resolver });
		const parsed = await runner.audit(auditInput(), opencodeRoute);
		expect(parsed).toEqual(verdict);
	});
});

describe("createPiOfficeRunner missing assistant text", () => {
	it("rejects when getLastAssistantText returns undefined", async () => {
		const handle = new FakeHandle({ textOverride: () => undefined });
		const resolver: PiOfficeActorResolver = () => handle;
		const runner = createPiOfficeRunner({ resolveActor: resolver });
		await expect(runner.plan(planning, route)).rejects.toThrow(
			/no assistant text/,
		);
	});

	it("rejects when getLastAssistantText returns an empty string", async () => {
		const handle = new FakeHandle({ textOverride: () => "" });
		const resolver: PiOfficeActorResolver = () => handle;
		const runner = createPiOfficeRunner({ resolveActor: resolver });
		await expect(runner.plan(planning, route)).rejects.toThrow(
			/no assistant text/,
		);
	});

	it("treats missing output as a plain error even when an over-eager classifier returns true", async () => {
		// Even a classifier that flags every error as capacity must not
		// turn missing assistant text into a ModelCapacityError: the
		// missing-output signal is raised outside the action try/catch,
		// so the classifier is never consulted. Track invocations to
		// pin both behaviors: the error shape and the absence of any
		// fallback classification.
		let classifyCalls = 0;
		const classifyCapacity = () => {
			classifyCalls += 1;
			return true;
		};
		const handle = new FakeHandle({ textOverride: () => undefined });
		const resolver: PiOfficeActorResolver = () => handle;
		const runner = createPiOfficeRunner({
			resolveActor: resolver,
			classifyCapacity,
		});
		let caught: unknown;
		try {
			await runner.plan(planning, route);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught).not.toBeInstanceOf(ModelCapacityError);
		expect((caught as Error).message).toMatch(/no assistant text/);
		expect(classifyCalls).toBe(0);
	});
});

describe("createPiOfficeRunner never retries after an ambiguous prompt failure", () => {
	it("makes a single prompt call when prompt() throws a generic error", async () => {
		const handle = new FakeHandle({
			behaviour: (call) => {
				if (call.kind === "prompt")
					throw new Error("ambiguous failure");
			},
		});
		const resolver: PiOfficeActorResolver = () => handle;
		const runner = createPiOfficeRunner({ resolveActor: resolver });
		await expect(runner.plan(planning, route)).rejects.toThrow(
			/ambiguous failure/,
		);
		const promptCalls = handle.calls.filter(
			(call) => call.kind === "prompt",
		);
		expect(promptCalls).toHaveLength(1);
	});
});

describe("createPiOfficeRunner capacity classification vs arbitrary failure", () => {
	it("maps an action error to ModelCapacityError when the classifier flags quota / capacity / token exhaustion", async () => {
		const handle = new FakeHandle({
			behaviour: (call) => {
				if (call.kind === "prompt") {
					throw {
						code: "rate_limit",
						message: "quota exhausted on minimax-m3",
					};
				}
			},
		});
		const resolver: PiOfficeActorResolver = () => handle;
		const classify = (error: unknown) =>
			typeof error === "object" &&
			error !== null &&
			(error as { code?: unknown }).code === "rate_limit";
		const runner = createPiOfficeRunner({
			resolveActor: resolver,
			classifyCapacity: classify,
		});
		let caught: unknown;
		try {
			await runner.plan(planning, route);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ModelCapacityError);
	});

	it("propagates an arbitrary error as a blocking error when the classifier returns false", async () => {
		const arbitrary = new Error("provider crashed unexpectedly");
		const handle = new FakeHandle({
			behaviour: (call) => {
				if (call.kind === "prompt") throw arbitrary;
			},
		});
		const resolver: PiOfficeActorResolver = () => handle;
		const runner = createPiOfficeRunner({
			resolveActor: resolver,
			classifyCapacity: () => false,
		});
		let caught: unknown;
		try {
			await runner.plan(planning, route);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(arbitrary);
	});

	it("does not classify malformed output as a capacity error", async () => {
		const handle = new FakeHandle({
			textOverride: () => "not json at all",
		});
		const resolver: PiOfficeActorResolver = () => handle;
		const runner = createPiOfficeRunner({
			resolveActor: resolver,
			classifyCapacity: () => true, // even an over-eager classifier must not absorb malformed output
		});
		let caught: unknown;
		try {
			await runner.plan(planning, route);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught).not.toBeInstanceOf(ModelCapacityError);
		expect((caught as Error).message).toMatch(/Office output rejected/);
	});
});

describe("createPiOfficeRunner rejects invalid thinking before the resolver runs", () => {
	it("refuses a high thinking value and never invokes the resolver", async () => {
		let resolved = 0;
		const resolver: PiOfficeActorResolver = () => {
			resolved += 1;
			return new FakeHandle({});
		};
		const runner = createPiOfficeRunner({ resolveActor: resolver });
		const bypass = {
			provider: "opencode-go",
			model: "grok-4.7",
			thinking: "high",
			tier: "open",
		} as unknown as ModelRoute;
		await expect(runner.plan(planning, bypass)).rejects.toThrow(
			/Office runner rejected thinking value/,
		);
		expect(resolved).toBe(0);
	});

	it("refuses a max thinking value and never invokes the resolver", async () => {
		let resolved = 0;
		const resolver: PiOfficeActorResolver = () => {
			resolved += 1;
			return new FakeHandle({});
		};
		const runner = createPiOfficeRunner({ resolveActor: resolver });
		const bypass = {
			provider: "minimax-direct",
			model: "minimax-m3",
			thinking: "max",
			tier: "fallback",
		} as unknown as ModelRoute;
		await expect(runner.work(worksInput(), bypass)).rejects.toThrow(
			/Office runner rejected thinking value/,
		);
		expect(resolved).toBe(0);
	});
});
