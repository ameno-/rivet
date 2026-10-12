import { Hono } from "hono";
import { expect, test } from "vitest";
import { mountMetricsRoute } from "../src/metrics.ts";

function routesReturning(response: Response) {
	return {
		calls: 0,
		prometheusMetrics(_request?: Request): Promise<Response> {
			this.calls += 1;
			return Promise.resolve(response.clone());
		},
	};
}

test("metrics reports 503 starting until the registry has started", async () => {
	const app = new Hono();
	const routes = routesReturning(
		new Response("# HELP x y\n", { status: 200 }),
	);
	mountMetricsRoute(app, routes, () => false);

	const response = await app.request("/metrics");
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ status: "starting" });
	// A scrape before the registry is live must not touch the runtime.
	expect(routes.calls).toBe(0);
});

test("metrics proxies the registry scrape once started", async () => {
	const app = new Hono();
	const body =
		"# HELP rivet_api_request_total requests\nrivet_api_request_total 3\n";
	const routes = routesReturning(
		new Response(body, {
			status: 200,
			headers: { "content-type": "text/plain; version=0.0.4" },
		}),
	);
	mountMetricsRoute(app, routes, () => true);

	const response = await app.request("/metrics");
	expect(response.status).toBe(200);
	expect(await response.text()).toBe(body);
	expect(response.headers.get("content-type")).toContain("text/plain");
	expect(routes.calls).toBe(1);
});

test("metrics surfaces an unsupported-runtime response verbatim", async () => {
	const app = new Hono();
	// rivetkit answers 501 when the active runtime cannot render metrics.
	const routes = routesReturning(
		new Response("metrics are not supported by this runtime\n", {
			status: 501,
		}),
	);
	mountMetricsRoute(app, routes, () => true);

	const response = await app.request("/metrics");
	expect(response.status).toBe(501);
});

test("metrics route does not capture unrelated paths", async () => {
	const app = new Hono();
	const routes = routesReturning(new Response("nope", { status: 200 }));
	mountMetricsRoute(app, routes, () => true);

	const response = await app.request("/api/rivet/metrics");
	expect(response.status).toBe(404);
	expect(routes.calls).toBe(0);
});
