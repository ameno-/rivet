/**
 * Vitest config used to run the live-shape harness tests.
 *
 * The default `vitest.config.ts` excludes `tests/live/**` so the
 * dry-run proof harness does not surface in regular CI runs. This
 * config inverts the filter so the operator can run
 *
 *   pnpm exec vitest run --config tests/live/vitest.live.config.ts
 *
 * to confirm the proof harness shape itself. The live harness does not
 * need a Rivet Engine for the live-shape suite; it only asserts the
 * dry-run guard, key derivation, and redaction behavior.
 */
import { defineConfig } from "vitest/config";
import type { ViteUserConfig } from "vitest/config";

/**
 * Self-contained Vitest config used to run the live-shape harness tests.
 *
 * The default `vitest.config.ts` excludes `tests/live/**` so the
 * dry-run proof harness does not surface in regular CI runs. This
 * config inverts the filter so the operator can run
 *
 *   pnpm exec vitest run --config tests/live/vitest.live.config.ts
 *
 * to confirm the proof harness shape itself. The live harness does not
 * need a Rivet Engine for the live-shape suite; it only asserts the
 * dry-run guard, key derivation, and redaction behavior.
 *
 * The base settings (timeouts, parallelism) match the project's
 * standard `vitest.base.ts`; inlining them keeps this config free of
 * cross-workspace imports and avoids the `rewriteRelativeImportExtensions`
 * constraint on `.ts` imports.
 */
const baseConfig: ViteUserConfig = {
	test: {
		testTimeout: 10_000,
		hookTimeout: 10_000,
		sequence: { concurrent: false },
		fileParallelism: false,
		env: {
			RIVET_LOG_LEVEL: "DEBUG",
			RIVET_LOG_TARGET: "1",
			RIVET_LOG_TIMESTAMP: "1",
			RIVET_LOG_ERROR_STACK: "1",
			RIVET_LOG_MESSAGE: "1",
		},
	},
};

export default defineConfig({
	...baseConfig,
	test: {
		...baseConfig.test,
		include: ["tests/live/live-shape.test.ts"],
		exclude: [],
	},
});
