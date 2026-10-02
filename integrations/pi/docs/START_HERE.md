# Start here: Pi and Rivet development

## Scope

Work in `integrations/pi`. The existing integration is the baseline. Durable
mode is a later additive capability, not a refactor to start opportunistically.

## Agent-core bootstrap

Run these commands from the repository root on `agent-core`:

```sh
pnpm install --frozen-lockfile
nix shell nixpkgs#cargo nixpkgs#rustc nixpkgs#gcc nixpkgs#pkg-config \
  --command pnpm --filter @rivetkit/rivetkit-napi run build
nix shell nixpkgs#cargo nixpkgs#rustc nixpkgs#gcc nixpkgs#pkg-config \
  --command cargo build -p rivet-engine
pnpm --filter rivetkit run build
pnpm --filter @rivet-dev/pi run check-types
RIVET_ENGINE_BINARY="$PWD/target/debug/rivet-engine" \
  pnpm --filter @rivet-dev/pi run test
```

The N-API build is required before Pi integration tests can run. It creates a
local platform artifact and does not belong in source control.

Use the local engine override for this checkout. The installed platform package
can be older than the source tree and reject newer engine configuration.

## First places to read

1. `ARCHITECTURE.md` for the system boundary and invariants.
2. `ROADMAP.md` for the active long-horizon loops and exit evidence.
3. `src/runtime.ts` and `src/storage.ts` for current session persistence.
4. `tests/pi-actor.test.ts` for the existing lifecycle and sandbox contract.

## Change protocol

1. Start a focused Jujutsu change before editing files.
2. Keep existing `AgentSession` actions compatible unless an issue explicitly
   authorizes a breaking surface.
3. Add a focused test for every recovery, storage, or replay rule.
4. Run the package typecheck and tests before handing off.
5. Record any unresolved system decision in the matching GitHub issue.
