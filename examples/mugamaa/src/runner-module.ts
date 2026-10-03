/**
 * OfficeRunner module loader.
 *
 * The operator never assumes an ambient runner; the caller must supply
 * an explicit local module path. The loader dynamically imports that
 * module and pulls out the runner via one of two shapes:
 *
 * - `module.runner` -- a directly exported {@link OfficeRunner} object.
 * - `module.createRunner()` -- a factory that may return either the
 *   runner synchronously or via a promise.
 *
 * Anything else is rejected with a clear, non-leaking error message.
 */

import { pathToFileURL } from "node:url";
import type { OfficeRunner } from "./types.ts";

export class RunnerModuleError extends Error {
	readonly code = "runner_module";
	constructor(message: string) {
		super(message);
		this.name = "RunnerModuleError";
	}
}

export interface LoadRunnerOptions {
	/**
	 * Filesystem path to a local TypeScript or JavaScript module. The
	 * path is converted to a `file://` URL so dynamic `import()` can
	 * resolve it on every supported runtime (Node, tsx, vitest).
	 */
	modulePath: string;
}

interface RunnerModuleShape {
	runner?: unknown;
	createRunner?: unknown;
}

/**
 * Load an {@link OfficeRunner} from the module at `modulePath`.
 *
 * The caller must explicitly opt in by supplying a path. There is no
 * implicit ambient runner, and the loader does not consult the working
 * directory or the operator's own module path when looking for the
 * runner.
 */
export async function loadOfficeRunner(
	options: LoadRunnerOptions,
): Promise<OfficeRunner> {
	const url = pathToFileURL(options.modulePath).href;
	let mod: unknown;
	try {
		mod = await import(url);
	} catch (error) {
		throw new RunnerModuleError(
			`Failed to import runner module "${options.modulePath}": ${describeError(error)}`,
		);
	}
	if (!isObjectRecord(mod)) {
		throw new RunnerModuleError(
			`Runner module "${options.modulePath}" did not export an object`,
		);
	}
	const shape = mod as RunnerModuleShape;
	if (typeof shape.createRunner === "function") {
		const factory = shape.createRunner as () => unknown;
		let produced: unknown;
		try {
			produced = factory();
		} catch (error) {
			throw new RunnerModuleError(
				`createRunner() in "${options.modulePath}" threw: ${describeError(error)}`,
			);
		}
		const resolved =
			produced instanceof Promise ? await produced : produced;
		return assertOfficeRunner(resolved, options.modulePath, "createRunner");
	}
	if (shape.runner !== undefined) {
		return assertOfficeRunner(shape.runner, options.modulePath, "runner");
	}
	throw new RunnerModuleError(
		`Runner module "${options.modulePath}" must export either "runner" or "createRunner"`,
	);
}

function assertOfficeRunner(
	value: unknown,
	modulePath: string,
	source: string,
): OfficeRunner {
	if (!isPlainObject(value)) {
		throw new RunnerModuleError(
			`Exported ${source} in "${modulePath}" is not an OfficeRunner`,
		);
	}
	const candidate = value as Record<string, unknown>;
	const plan = candidate.plan;
	const work = candidate.work;
	const audit = candidate.audit;
	if (typeof plan !== "function") {
		throw new RunnerModuleError(
			`Exported ${source} in "${modulePath}" is missing plan(input, route)`,
		);
	}
	if (typeof work !== "function") {
		throw new RunnerModuleError(
			`Exported ${source} in "${modulePath}" is missing work(input, route)`,
		);
	}
	if (typeof audit !== "function") {
		throw new RunnerModuleError(
			`Exported ${source} in "${modulePath}" is missing audit(input, route)`,
		);
	}
	return value as unknown as OfficeRunner;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

/** ESM module namespaces have a null prototype, so they are records but not plain objects. */
function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
