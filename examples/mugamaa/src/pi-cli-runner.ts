import { createLiveRunner } from "./live-runner.ts";
import { createPiCliTransport } from "./pi-cli-transport.ts";
import type { OfficeRunner } from "./types.ts";

/**
 * Explicit runner module for the manual Mugamaa operator.
 *
 * The child inherits Pi's provider configuration and credentials from the
 * operator process. Set `MUGAMAA_PI_EXECUTABLE` when `pi` is not on PATH and
 * `MUGAMAA_PI_CWD` when office calls should execute from a different working
 * directory. Neither value is written to the case receipt.
 */
export function createRunner(): OfficeRunner {
	return createLiveRunner({
		transport: createPiCliTransport({
			executable: process.env.MUGAMAA_PI_EXECUTABLE,
			cwd: process.env.MUGAMAA_PI_CWD,
		}),
	});
}
