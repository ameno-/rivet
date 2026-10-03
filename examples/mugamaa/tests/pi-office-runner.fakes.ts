/**
 * Test-only support for the Pi Office runner suite. Provides the
 * `FakeHandle` recorder and the `recordingResolver` factory that every
 * `pi-office-runner*.test.ts` file consumes. Kept small on purpose:
 * the runner's behavior is verified through these fakes, never by
 * reaching into real Pi internals.
 */
import type {
	PiOfficeActorResolver,
	PiOfficeHandle,
} from "../src/pi-office-runner.ts";
import type { ModelProvider, ThinkingLevel } from "../src/types.ts";

/** Captures every action invocation on a fake handle, in order. */
export type Call =
	| { kind: "setModel"; provider: ModelProvider; modelId: string }
	| { kind: "setThinkingLevel"; level: ThinkingLevel }
	| { kind: "prompt"; text: string }
	| { kind: "getLastAssistantText" };

export class FakeHandle implements PiOfficeHandle {
	readonly calls: Call[] = [];
	#assistantText: string | undefined;
	#behaviour: (call: Call) => void | Promise<void>;
	#textOverride: () => string | undefined;

	constructor(options: {
		behaviour?: (call: Call) => void | Promise<void>;
		textOverride?: () => string | undefined;
	}) {
		this.#behaviour = options.behaviour ?? (() => {});
		this.#textOverride = options.textOverride ?? (() => undefined);
	}

	async setModel(provider: ModelProvider, modelId: string): Promise<void> {
		const call: Call = { kind: "setModel", provider, modelId };
		this.calls.push(call);
		await this.#behaviour(call);
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		const call: Call = { kind: "setThinkingLevel", level };
		this.calls.push(call);
		await this.#behaviour(call);
	}

	async prompt(text: string): Promise<void> {
		const call: Call = { kind: "prompt", text };
		this.calls.push(call);
		const override = this.#textOverride();
		if (override !== undefined) this.#assistantText = override;
		await this.#behaviour(call);
	}

	async getLastAssistantText(): Promise<string | undefined> {
		const call: Call = { kind: "getLastAssistantText" };
		this.calls.push(call);
		await this.#behaviour(call);
		return this.#assistantText;
	}
}

export interface RecordingResolver {
	resolver: PiOfficeActorResolver;
	handles: Map<string, FakeHandle>;
}

/**
 * Builds a resolver that lazily creates a {@link FakeHandle} per
 * actor key, plus a {@link Map} the tests can inspect for the recorded
 * call sequence. Optional `textForKey` seeds each freshly built handle
 * with a deterministic assistant-text override.
 */
export function recordingResolver(
	textForKey: (key: string) => string | undefined = () => undefined,
): RecordingResolver {
	const handles = new Map<string, FakeHandle>();
	const resolver: PiOfficeActorResolver = (key) => {
		let handle = handles.get(key);
		if (!handle) {
			handle = new FakeHandle({ textOverride: () => textForKey(key) });
			handles.set(key, handle);
		}
		return handle;
	};
	return { resolver, handles };
}
