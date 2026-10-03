import { assertAcceptedThinking, ModelCapacityError } from "./model-policy.ts";
import {
	parseAuditVerdict,
	parseProductArtifact,
	parseWorkOrder,
} from "./office-output.ts";
import { auditPrompt, planningPrompt, worksPrompt } from "./office-prompts.ts";
import {
	isOfficeTransportError,
	type OfficeTransport,
} from "./office-transport.ts";
import type {
	AuditInput,
	AuditVerdict,
	ModelRoute,
	OfficeRunner,
	PlanningInput,
	ProductArtifact,
	WorkOrder,
	WorksInput,
} from "./types.ts";

/**
 * Live runner composed from a transport and pure prompt/parser modules. The
 * runner never invents provider-specific behavior: malformed structured
 * output and arbitrary provider errors reject the request and propagate;
 * only the explicit ModelCapacityError fallback path is wired through.
 */
export interface LiveRunnerOptions {
	transport: OfficeTransport;
}

export function createLiveRunner(options: LiveRunnerOptions): OfficeRunner {
	const transport = options.transport;
	return {
		async plan(
			input: PlanningInput,
			route: ModelRoute,
		): Promise<WorkOrder> {
			const reply = await transportRequest(
				transport,
				route,
				planningPrompt(input),
			);
			const parsed = parseWorkOrder(reply);
			if (!parsed.ok) rejectStructured(parsed.reason);
			return parsed.value;
		},
		async work(
			input: WorksInput,
			route: ModelRoute,
		): Promise<ProductArtifact> {
			const reply = await transportRequest(
				transport,
				route,
				worksPrompt(input),
			);
			const parsed = parseProductArtifact(reply);
			if (!parsed.ok) rejectStructured(parsed.reason);
			return parsed.value;
		},
		async audit(
			input: AuditInput,
			route: ModelRoute,
		): Promise<AuditVerdict> {
			const reply = await transportRequest(
				transport,
				route,
				auditPrompt(input),
			);
			const parsed = parseAuditVerdict(reply);
			if (!parsed.ok) rejectStructured(parsed.reason);
			return parsed.value;
		},
	};
}

async function transportRequest(
	transport: OfficeTransport,
	route: ModelRoute,
	prompt: string,
): Promise<string> {
	// Runtime guard at the live runner boundary: the route's thinking level
	// must be one of the accepted values before any transport call is
	// attempted. We do not silently clamp — a malformed value (cast,
	// JSON-derived, or otherwise) must surface here so the caller can fix
	// the wiring instead of receiving a quietly-downgraded request.
	const thinking = assertAcceptedThinking(route.thinking);
	try {
		const response = await transport.request({
			provider: route.provider,
			model: route.model,
			thinking,
			prompt,
		});
		return response.body;
	} catch (error) {
		if (isOfficeTransportError(error)) {
			if (error.kind === "capacity") {
				throw new ModelCapacityError(error.message);
			}
			throw new Error(
				`Office transport rejected request: ${error.message}`,
			);
		}
		throw error;
	}
}

function rejectStructured(reason: string): never {
	throw new Error(`Office output rejected: ${reason}`);
}
