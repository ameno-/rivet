import { describe, expect, it } from "vitest";
import { createLiveRunner } from "../src/live-runner.ts";
import { ModelCapacityError } from "../src/model-policy.ts";
import type {
	OfficeTransport,
	OfficeTransportError,
	OfficeTransportRequest,
	OfficeTransportResponse,
} from "../src/office-transport.ts";
import type {
	AuditInput,
	ModelRoute,
	PlanningInput,
	WorksInput,
} from "../src/types.ts";

class FakeTransport implements OfficeTransport {
	readonly calls: OfficeTransportRequest[] = [];
	#handler: (req: OfficeTransportRequest) => Promise<OfficeTransportResponse>;

	constructor(
		handler: (
			req: OfficeTransportRequest,
		) => Promise<OfficeTransportResponse>,
	) {
		this.#handler = handler;
	}

	async request(
		req: OfficeTransportRequest,
	): Promise<OfficeTransportResponse> {
		this.calls.push(req);
		return this.#handler(req);
	}
}

function rejectTransport(error: OfficeTransportError): FakeTransport {
	return new FakeTransport(async () => {
		throw error;
	});
}

function okTransport(body: string): FakeTransport {
	return new FakeTransport(async () => ({ status: 200, body }));
}

const route = {
	provider: "minimax-direct" as const,
	model: "minimax-m3",
	thinking: "low" as const,
	tier: "fallback" as const,
};

const planning: PlanningInput = {
	charter: {
		id: "live-runner-test",
		title: "live runner",
		objective: "verify strict output parsing and capacity-only fallback",
		acceptanceCriteria: ["Output is strictly validated"],
		constraints: [],
		maxIterations: 1,
	},
	iteration: 1,
	previousVerdicts: [],
};

describe("createLiveRunner", () => {
	it("returns a strict WorkOrder when transport body parses cleanly", async () => {
		const transport = okTransport(
			JSON.stringify({
				summary: "Plan",
				tasks: ["task"],
				successConditions: ["condition"],
			}),
		);
		const runner = createLiveRunner({ transport });
		const order = await runner.plan(planning, route);
		expect(order.summary).toBe("Plan");
		expect(order.tasks).toEqual(["task"]);
	});

	it("rejects malformed WorkOrder output without falling back", async () => {
		const transport = okTransport("not json at all");
		const runner = createLiveRunner({ transport });
		await expect(runner.plan(planning, route)).rejects.toThrow(
			/Office output rejected/,
		);
	});

	it("rejects arbitrary provider errors without falling back", async () => {
		const transport = rejectTransport({
			kind: "reject",
			status: 500,
			message: "provider crashed",
		});
		const runner = createLiveRunner({ transport });
		await expect(runner.plan(planning, route)).rejects.toThrow(
			/Office transport rejected/,
		);
	});

	it("raises ModelCapacityError when transport reports quota exhaustion", async () => {
		const transport = rejectTransport({
			kind: "capacity",
			status: 429,
			message: "rate limit",
		});
		const runner = createLiveRunner({ transport });
		let caught: unknown;
		try {
			await runner.plan(planning, route);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ModelCapacityError);
	});

	it("never embeds credentials, base URLs, or header values in the prompt", async () => {
		let captured: OfficeTransportRequest | undefined;
		const transport = new FakeTransport(async (req) => {
			captured = req;
			return {
				status: 200,
				body: JSON.stringify({
					summary: "x",
					tasks: ["t"],
					successConditions: ["c"],
				}),
			};
		});
		const runner = createLiveRunner({ transport });
		await runner.plan(planning, route);
		expect(captured).toBeDefined();
		const prompt = captured?.prompt ?? "";
		expect(prompt).not.toMatch(/bearer/i);
		expect(prompt).not.toMatch(/https?:\/\//i);
	});

	it("does not perform network calls when only fake transport is wired", async () => {
		const transport = okTransport(
			JSON.stringify({
				summary: "plan",
				tasks: ["t"],
				successConditions: ["c"],
			}),
		);
		const runner = createLiveRunner({ transport });
		const order = await runner.plan(planning, route);
		expect(order.summary).toBe("plan");
		expect(transport.calls).toHaveLength(1);
	});

	it("uses the route's model verbatim without rewriting the request", async () => {
		const opencodeRoute = {
			provider: "opencode-go" as const,
			model: "grok-4.7",
			thinking: "medium" as const,
			tier: "open" as const,
		};
		const transport = okTransport(
			JSON.stringify({
				summary: "a",
				body: "b",
				evidence: ["e"],
			}),
		);
		const runner = createLiveRunner({ transport });
		const input: WorksInput = {
			...planning,
			workOrder: {
				summary: "w",
				tasks: ["t"],
				successConditions: ["c"],
			},
		};
		await runner.work(input, opencodeRoute);
		expect(transport.calls[0]?.model).toBe("grok-4.7");
	});

	it("forwards the route's thinking level to the transport verbatim", async () => {
		const transport = new FakeTransport(async (req) => {
			if (req.model === "grok-4.7") {
				return {
					status: 200,
					body: JSON.stringify({
						summary: "a",
						body: "b",
						evidence: ["e"],
					}),
				};
			}
			return {
				status: 200,
				body: JSON.stringify({
					summary: "a",
					tasks: ["t"],
					successConditions: ["c"],
				}),
			};
		});
		const runner = createLiveRunner({ transport });
		const input: WorksInput = {
			...planning,
			workOrder: {
				summary: "w",
				tasks: ["t"],
				successConditions: ["c"],
			},
		};
		const mediumRoute = {
			provider: "opencode-go" as const,
			model: "grok-4.7",
			thinking: "medium" as const,
			tier: "open" as const,
		};
		await runner.work(input, mediumRoute);
		expect(transport.calls[0]?.thinking).toBe("medium");

		const lowRoute = {
			provider: "minimax-direct" as const,
			model: "minimax-m3",
			thinking: "low" as const,
			tier: "fallback" as const,
		};
		await runner.plan(planning, lowRoute);
		expect(transport.calls[1]?.thinking).toBe("low");
	});

	it("returns a strict AuditVerdict when transport body parses cleanly", async () => {
		const transport = okTransport(
			JSON.stringify({
				decision: "pass",
				rationale: "all good",
				findings: [],
			}),
		);
		const runner = createLiveRunner({ transport });
		const input: AuditInput = {
			charter: planning.charter,
			iteration: 1,
			workOrder: {
				summary: "w",
				tasks: ["t"],
				successConditions: ["c"],
			},
			artifact: { summary: "s", body: "b", evidence: ["e"] },
		};
		const verdict = await runner.audit(input, route);
		expect(verdict.decision).toBe("pass");
		expect(verdict.rationale).toBe("all good");
	});

	it("rejects audit output with an invalid decision enum", async () => {
		const transport = okTransport(
			JSON.stringify({
				decision: "approve",
				rationale: "r",
				findings: [],
			}),
		);
		const runner = createLiveRunner({ transport });
		const input: AuditInput = {
			charter: planning.charter,
			iteration: 1,
			workOrder: {
				summary: "w",
				tasks: ["t"],
				successConditions: ["c"],
			},
			artifact: { summary: "s", body: "b", evidence: ["e"] },
		};
		await expect(runner.audit(input, route)).rejects.toThrow(
			/Office output rejected/,
		);
	});

	it("rejects a high thinking value before the transport is called", async () => {
		// Simulate a route whose thinking field was set to a value outside
		// the accepted "low" | "medium" set (e.g. from a JSON round-trip or
		// a stray cast). The live runner must reject it before invoking the
		// transport; it must never silently clamp to "low" or "medium".
		const transport = okTransport(
			JSON.stringify({
				summary: "a",
				tasks: ["t"],
				successConditions: ["c"],
			}),
		);
		const runner = createLiveRunner({ transport });
		const bypassRoute = {
			provider: "opencode-go",
			model: "grok-4.7",
			thinking: "high",
			tier: "open",
		} as unknown as ModelRoute;
		await expect(runner.plan(planning, bypassRoute)).rejects.toThrow(
			/Office runner rejected thinking value/,
		);
		expect(transport.calls).toHaveLength(0);
	});

	it("rejects a max thinking value before the transport is called", async () => {
		const transport = okTransport(
			JSON.stringify({
				summary: "a",
				body: "b",
				evidence: ["e"],
			}),
		);
		const runner = createLiveRunner({ transport });
		const bypassRoute = {
			provider: "minimax-direct",
			model: "minimax-m3",
			thinking: "max",
			tier: "fallback",
		} as unknown as ModelRoute;
		const input: WorksInput = {
			...planning,
			workOrder: {
				summary: "w",
				tasks: ["t"],
				successConditions: ["c"],
			},
		};
		await expect(runner.work(input, bypassRoute)).rejects.toThrow(
			/Office runner rejected thinking value/,
		);
		expect(transport.calls).toHaveLength(0);
	});

	it("rejects a missing thinking value before the transport is called", async () => {
		const transport = okTransport(
			JSON.stringify({
				summary: "a",
				tasks: ["t"],
				successConditions: ["c"],
			}),
		);
		const runner = createLiveRunner({ transport });
		const bypassRoute = {
			provider: "opencode-go",
			model: "grok-4.7",
			thinking: undefined,
			tier: "open",
		} as unknown as ModelRoute;
		await expect(runner.plan(planning, bypassRoute)).rejects.toThrow(
			/Office runner rejected thinking value/,
		);
		expect(transport.calls).toHaveLength(0);
	});

	it("forwards low thinking to the transport unchanged", async () => {
		const transport = okTransport(
			JSON.stringify({
				summary: "a",
				tasks: ["t"],
				successConditions: ["c"],
			}),
		);
		const runner = createLiveRunner({ transport });
		const lowRoute = {
			provider: "minimax-direct" as const,
			model: "minimax-m3",
			thinking: "low" as const,
			tier: "fallback" as const,
		};
		await runner.plan(planning, lowRoute);
		expect(transport.calls[0]?.thinking).toBe("low");
	});

	it("forwards medium thinking to the transport unchanged", async () => {
		const transport = okTransport(
			JSON.stringify({
				summary: "a",
				body: "b",
				evidence: ["e"],
			}),
		);
		const runner = createLiveRunner({ transport });
		const input: WorksInput = {
			...planning,
			workOrder: {
				summary: "w",
				tasks: ["t"],
				successConditions: ["c"],
			},
		};
		const mediumRoute = {
			provider: "opencode-go" as const,
			model: "grok-4.7",
			thinking: "medium" as const,
			tier: "open" as const,
		};
		await runner.work(input, mediumRoute);
		expect(transport.calls[0]?.thinking).toBe("medium");
	});
});
