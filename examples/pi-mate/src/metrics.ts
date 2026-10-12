/**
 * Prometheus metrics endpoint for the standalone Pi Mate service.
 *
 * Mirrors `example-mugamaa/src/runtime.ts`: the rivetkit registry owns the
 * registry-level metrics (actor lifecycle, workflow dispatch, runtime
 * internals) and exposes them through `registry.routes.prometheusMetrics`.
 *
 * The Mate deliberately adds no counters of its own here. The only signals
 * it could own (prompt latency, aborts, session wake/sleep) are already
 * recorded on the actor's durable event stream, and this route must never
 * echo prompt text, model output, or credential material into a scrape.
 * Scraping is counts and durations only.
 */

import type { Hono } from "hono";

/** The subset of `registry.routes` this route needs. */
export interface MetricsRoutes {
	prometheusMetrics(request?: Request): Promise<Response>;
}

/**
 * Mount `GET /metrics` on an existing Hono app.
 *
 * Returns 503 before the registry has started so a scrape during boot is
 * distinguishable from a scrape against a serving runtime, matching the
 * `/ready` contract in `health.ts`.
 */
export function mountMetricsRoute(
	app: Hono,
	routes: MetricsRoutes,
	isStarted: () => boolean,
): void {
	app.get("/metrics", async (c) => {
		if (!isStarted()) {
			return c.json({ status: "starting" }, 503);
		}
		return routes.prometheusMetrics(c.req.raw);
	});
}
