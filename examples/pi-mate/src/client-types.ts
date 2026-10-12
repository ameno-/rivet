/**
 * Public type boundary for the standalone Rivet Pi Mate service.
 *
 * This module is the single source of truth for the registry type an external
 * integrator (Centaur, in the prototype) needs to construct a typed RivetKit
 * client without importing the example source into its own Slack glue.
 *
 * The file uses `import type` so it is erased at runtime — the package never
 * depends on a built `pi-mate` artifact, never instantiates the registry, and
 * never reads a credential. A type-only consumer can depend on this module
 * via a TypeScript path mapping or a path-based pnpm dependency.
 *
 * The shipped types:
 *
 * - {@link PiMateRegistry}: the concrete `Registry<...>` shape returned by
 *   {@link buildPiMateRegistry}; this is what `createClient<typeof registry>`
 *   expects from `rivetkit/client`.
 * - {@link PiMateActorName}: the single actor name exposed by the registry
 *   (`firstMate`). Provided as a const-typed string so consumers can index
 *   the typed client without resorting to `as`.
 * - {@link PiMateActorKey}: the stable three-segment tuple documented in
 *   `firstMateActorKey`. Re-declared here (rather than imported) so a type-only
 *   consumer does not pull in the key-derivation module either.
 * - {@link PiMateClientError}: a thin error surface the typed adapter throws
 *   for protocol/transport failures. The adapter layer wraps the RivetKit
 *   driver errors in this shape so the Slack bridge never sees the version-
 *   coupled runner protocol directly.
 */

import type { buildPiMateRegistry, FIRST_MATE_ACTOR_NAME } from "./actors.ts";

/**
 * The registry type an external integrator passes to
 * `createClient<typeof registry>` from `rivetkit/client`. Derived from the
 * concrete return type of `buildPiMateRegistry`, so the typing stays in sync
 * with whatever actor list, sandbox, and credential wiring the Pi Mate ships.
 */
export type PiMateRegistry = ReturnType<typeof buildPiMateRegistry>;

/** The single actor name the Pi Mate registry exposes. */
export type PiMateActorName = typeof FIRST_MATE_ACTOR_NAME;

/**
 * The stable four-segment actor key the Mate addresses every prompt under.
 * Re-declared to match `firstMateActorKey`
 * (`["mate", ownerScope, projectId, threadId]`) so type-only consumers do not
 * have to import the key-derivation module. The fourth segment is the
 * per-conversation partition; see ADR-0002.
 */
export type PiMateActorKey = readonly [string, string, string, string];

/**
 * Errors surfaced by the typed adapter. The category is stable; the
 * `message` carries the human-readable detail. Slack-side glue renders the
 * `unavailable` cases as ephemeral Slack notices; everything else is
 * logged but not surfaced to the user.
 */
export type PiMateClientError =
	| { kind: "unavailable"; message: string }
	| { kind: "rejected"; message: string }
	| { kind: "transport"; message: string }
	| { kind: "protocol"; message: string };

/** Concrete error class carrying a stable `kind` discriminator. */
export type PiMateClientErrorKind = PiMateClientError["kind"];

export class PiMateClientErrorImpl extends Error {
	readonly kind: PiMateClientErrorKind;
	constructor(kind: PiMateClientErrorKind, message: string) {
		super(message);
		this.name = "PiMateClientError";
		this.kind = kind;
	}
}
