import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

/**
 * The Pi Mate service tests are deterministic unit tests. The live Engine
 * path requires a RivetKit native binary (Node >= 22.19 plus a built
 * `@rivetkit/rivetkit-napi`) and a `RIVET_ENGINE_BINARY`; see
 * `README.md#live-prerequisite`. Vitest runs only the unit suite here.
 *
 * `sequence.concurrent: false` keeps the env-mutating config tests
 * isolated from their siblings within the same file.
 */
export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			include: ["tests/**/*.test.ts"],
			exclude: ["tests/live/**"],
			sequence: { concurrent: false },
			fileParallelism: false,
		},
	}),
);
