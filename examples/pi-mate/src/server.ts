/**
 * Handler-mode HTTP server for the standalone Pi Mate service.
 *
 * This entrypoint serves the registry through a generic HTTP host. Use
 * it for local development and tests where the registry runtime is built
 * lazily on the first request. The standalone runtime entrypoint
 * (`src/runtime.ts`) is the production-shaped alternative that owns its
 * own startup.
 */

import { createHealthApp } from "./health.ts";
import { buildPiMateRegistry } from "./actors.ts";
import { mountMetricsRoute } from "./metrics.ts";

const app = createHealthApp(
	// In handler mode the registry runtime is built lazily on the first
	// `/api/rivet` request, so `/ready` reports 200 as soon as the HTTP
	// process is serving. The full probe runs against a live runtime in
	// `src/runtime.ts`.
	{ health: async () => new Response(null, { status: 200 }) },
	() => true,
);

const registry = buildPiMateRegistry();
// The scrape target must not answer before the lazy registry has been
// built, so the same predicate `/ready` uses gates it here.
mountMetricsRoute(app, registry.routes, () => true);
app.all("/api/rivet/*", (c) => registry.handler(c.req.raw));
app.all("/api/rivet", (c) => registry.handler(c.req.raw));

export default app;
