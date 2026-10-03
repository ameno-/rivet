# Mugamaa Persistent Supervisor Handoff Runbook

Read this after `HANDOFF.md`. It contains the execution gates and operational
constraints for that handoff.

## Testing requirements

Use deterministic fakes for unit tests and isolated storage/ports for native
actor tests. Normal test runs must not contact live models.

Required test layers:

- Supervisor state/action/queue unit tests.
- Duplicate submission and command idempotency tests.
- Case summary delivery retry tests.
- Pi Office resolver behavior tests with fake handles.
- Capacity-only fallback tests.
- Audit fan-out/fan-in ordering tests.
- Runtime HTTP health/readiness tests.
- Runtime restart integration test.
- Engine restart with persistent storage test.
- Actor sleep/wake test.
- Ambiguous Office interruption test with an invocation counter.
- One opt-in live model smoke outside the default test suite.

Existing focused gate:

```sh
cd /home/ameno/Projects/mugamaa-live-offices
pnpm biome check examples/mugamaa
pnpm --filter example-mugamaa check-types
cd examples/mugamaa
pnpm exec vitest run \
  tests/case-receipt-store.test.ts \
  tests/charter-validation.test.ts \
  tests/live-runner.test.ts \
  tests/mugamaa.test.ts \
  tests/office-live-transport.test.ts \
  tests/office-prompts.test.ts \
  tests/operator.test.ts \
  tests/phases.test.ts \
  tests/pi-cli-transport.test.ts \
  tests/pi-office-runner.behavior.test.ts \
  tests/pi-office-runner.keys.test.ts
```

For the current native actor test, use a fresh storage directory and unused
port family. Reusing ports/storage has awakened stale test actors and caused
false failures:

```sh
storage_dir=$(mktemp -d /tmp/mugamaa-actor.XXXXXX)
RIVETKIT_STORAGE_PATH="$storage_dir" \
RIVET_RUN_ENGINE_PORT=18200 \
RIVET_RUN_SERVICES=0 \
RIVET_ENGINE_BINARY=/home/ameno/Projects/rivet-pi-durable/target/debug/rivet-engine \
pnpm exec vitest run tests/actor.test.ts
```

Choose a genuinely unused port family; Engine may occupy adjacent ports. A
passing test can emit a shutdown warning that the SQLite transaction
coordinator is already closed. Record it, but distinguish it from assertion
failure.

## Definition of done

- A pinned Engine service and separately restartable Mugamaa runtime run on
  agent-core.
- One stable Supervisor actor admits a charter through a durable, idempotent
  path and resolves one stable Case actor.
- Planning, Works, and Audit use Pi actors, not the Pi CLI.
- Policy remains Kimi/Grok/GLM with direct MiniMax capacity fallback and only
  low/medium thinking.
- Supervisor-requested revision continues the same case.
- Runtime restart between phases does not repeat completed model calls.
- Ambiguous in-flight Office interruption blocks for reconciliation and is not
  automatically replayed.
- Product/process receipts stay inspectable and credential-free.
- Deterministic tests, typecheck, formatter, actor integration, and explicit
  live smoke pass.
- Documentation states exactly which restart/failure boundaries were proven.

## Operational cautions

- `agent-core` is reachable through `agent-core-lan`.
- The remote machine may lack GitHub CLI authentication even when the local Mac
  can push. Check `gh auth status`; do not leave a GUI credential helper hung.
- The checkout is colocated Jujutsu/Git. External Git operations can cause
  Jujutsu to import a new Git HEAD and create an empty working-copy revision.
  Inspect `jj log` before publishing.
- Do not publish empty or divergent revisions.
- Never force-push to hide mistakes; repair additively.
- Do not claim crash recovery without the explicit process-kill receipt.
- Do not add GPT/Codex routes that consume the owner's Codex subscription.
- Do not route MiniMax through OpenCode; use the direct subscription.
- Keep source files near 500 lines or less and split by responsibility.
