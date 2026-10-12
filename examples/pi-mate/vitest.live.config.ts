import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

/**
 * Vitest config for the live-harness shape suite under `tests/live/`.
 *
 * These tests never touch a live Engine: they assert the harness shape
 * itself (prereq reading, key derivation, redaction, phase planning) in
 * dry-run mode. The main `vitest.config.ts` excludes `tests/live/**`
 * because those assertions are about the operator-driven harness, not
 * the deterministic unit surface of the service; run them with:
 *
 *   pnpm --filter example-pi-mate test:live
 */
export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			include: ["tests/live/**/*.test.ts"],
			sequence: { concurrent: false },
			fileParallelism: false,
		},
	}),
);
