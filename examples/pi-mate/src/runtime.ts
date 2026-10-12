/**
 * Standalone Pi Mate runtime: the separately restartable actor host that
 * connects to an externally managed Rivet Engine.
 *
 * Mirrors the layout of `example-mugamaa/src/runtime.ts` but is scoped to
 * the Pi Mate registry. The Engine owns scheduling, routing, actor
 * persistence, and workflow history; this process is only the current
 * executor generation. Killing and restarting it must not lose or
 * duplicate actor state.
 *
 * The deployed runtime refuses loopback Engine endpoints, in line with
 * the architecture contract: the standalone service never starts its own
 * Engine. Local development uses `src/server.ts` instead.
 */

import { serve } from "@hono/node-server";
import {
	FIRST_MATE_ACTOR_NAME,
	buildPiMateRegistry,
	logSafeConfig,
} from "./actors.ts";
import {
	type PiMateConfig,
	loadPiMateConfig,
	PiMateConfigError,
} from "./config.ts";
import { createHealthApp } from "./health.ts";
import { mountMetricsRoute } from "./metrics.ts";

const DEFAULT_PORT = 6423;
const DEFAULT_HOST = "127.0.0.1";

export class RuntimeConfigError extends Error {
	readonly code = "runtime_config";
	constructor(message: string) {
		super(message);
		this.name = "RuntimeConfigError";
	}
}

/**
 * Validate the Engine endpoint for the deployed runtime. Returns the
 * endpoint unchanged so the standard RivetKit env resolution remains the
 * single place that interprets it.
 */
export function assertExternalEndpoint(
	endpoint: string | undefined,
	rejectLoopback: boolean,
): string {
	if (!endpoint || !endpoint.trim()) {
		throw new RuntimeConfigError(
			"RIVET_ENDPOINT is required: the Pi Mate runtime connects to an externally managed Rivet Engine and never starts its own",
		);
	}
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new RuntimeConfigError(
			"RIVET_ENDPOINT is not a valid URL; expected for example http://agent-core-lan:6420",
		);
	}
	if (rejectLoopback && isLoopbackHost(url.hostname)) {
		throw new RuntimeConfigError(
			"RIVET_ENDPOINT must not be loopback in the deployed runtime: RivetKit's engine spawn mode is Auto on loopback endpoints and this process could adopt or spawn a co-located Engine. Use the Engine's LAN address (for example http://agent-core-lan:6420) even when the Engine runs on the same host. For local development use server.ts instead.",
		);
	}
	return endpoint;
}

function isLoopbackHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	if (host === "[::1]" || host === "::1") return true;
	if (host.startsWith("127.")) return true;
	return false;
}

function resolvePort(value: string | undefined): number {
	if (value === undefined || value.trim() === "") return DEFAULT_PORT;
	const port = Number.parseInt(value, 10);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new RuntimeConfigError(
			`PORT must be an integer between 1 and 65535, received ${JSON.stringify(value)}`,
		);
	}
	return port;
}

function redactEndpoint(endpoint: string): string {
	try {
		const url = new URL(endpoint);
		return url.origin;
	} catch {
		return "<invalid>";
	}
}

export async function main(
	config: PiMateConfig = loadPiMateConfig(),
): Promise<void> {
	const endpoint = assertExternalEndpoint(
		process.env.RIVET_ENDPOINT,
		config.rejectLoopbackEndpoint,
	);
	const port = resolvePort(process.env.PORT);
	const host = process.env.HOST ?? DEFAULT_HOST;

	const registry = buildPiMateRegistry(config);
	// The host owns signal policy; the registry's own SIGINT/SIGTERM
	// handlers are disabled so HTTP shutdown and the registry drain stay
	// ordered.
	registry.config.shutdown = { disableSignalHandlers: true };

	let started = false;
	const app = createHealthApp(registry.routes, () => started);
	// Prometheus scrape target for the operator stack. Counts and
	// durations only; see src/metrics.ts.
	mountMetricsRoute(app, registry.routes, () => started);

	const server = serve({ fetch: app.fetch, port, hostname: host });
	const address = `http://${host}:${port}`;

	let shuttingDown = false;
	const shutdown = (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(
			JSON.stringify({
				kind: "pi_mate_runtime_shutdown",
				signal,
				pid: process.pid,
			}),
		);
		server.close();
		void registry
			.shutdown()
			.catch((error: unknown) => {
				console.error(
					JSON.stringify({
						kind: "pi_mate_registry_shutdown_error",
						error:
							error instanceof Error
								? error.message
								: String(error),
					}),
				);
			})
			.finally(() => {
				process.exit(signal === "SIGINT" ? 130 : 143);
			});
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));

	logSafeConfig(config);
	console.log(
		JSON.stringify({
			kind: "pi_mate_runtime_starting",
			engine: redactEndpoint(endpoint),
			health: address,
			pid: process.pid,
			actor: FIRST_MATE_ACTOR_NAME,
		}),
	);

	try {
		await registry.startAndWait();
	} catch (error) {
		console.error(
			JSON.stringify({
				kind: "pi_mate_runtime_start_failed",
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		server.close();
		process.exit(1);
	}
	started = true;
	console.log(
		JSON.stringify({
			kind: "pi_mate_runtime_ready",
			engine: redactEndpoint(endpoint),
			health: address,
			pid: process.pid,
		}),
	);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	try {
		await main();
	} catch (error) {
		if (
			error instanceof RuntimeConfigError ||
			error instanceof PiMateConfigError
		) {
			console.error(
				JSON.stringify({
					kind: "pi_mate_config_error",
					error: error.message,
				}),
			);
			process.exit(2);
		}
		throw error;
	}
}
