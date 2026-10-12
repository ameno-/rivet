/**
 * Health and readiness endpoints shared by the handler-mode server
 * (`src/server.ts`) and the standalone runtime (`src/runtime.ts`).
 *
 * `/health` answers as soon as the HTTP process is serving, so a
 * supervisor can distinguish a dead process from an unready one.
 * `/ready` proxies the RivetKit registry health probe once the runtime
 * has finished its `startAndWait`, mirroring `example-mugamaa`.
 */

import { Hono } from "hono";

export interface ReadinessProbe {
	health(): Promise<Response>;
}

export function createHealthApp(
	probe: ReadinessProbe,
	isStarted: () => boolean,
): Hono {
	const app = new Hono();
	app.get("/health", (c) => c.json({ status: "ok" }));
	app.get("/ready", async (c) => {
		if (!isStarted()) {
			return c.json({ status: "starting" }, 503);
		}
		const response = await probe.health();
		return new Response(response.body, {
			status: response.status,
			headers: response.headers,
		});
	});
	return app;
}
