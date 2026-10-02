# The Mugamaa

Mugamaa Seed is the smallest working form of the factory: one Goal Charter,
one bounded plan-work-audit loop, append-only records, and an inspectable final
verdict.

The seed intentionally has no inbox, ticket adapter, repository mutation, or
parallel case scheduling. Office implementations are injected. Tests use
deterministic scripted offices; later adapters can use Pi actors and the
Inference Coordinator without changing the case protocol.

```sh
pnpm --filter example-mugamaa check-types
RIVET_ENGINE_BINARY="$PWD/target/debug/rivet-engine" \
  pnpm --filter example-mugamaa test
pnpm --filter example-mugamaa sample
```

The model policy records the intended OpenCode, Codex, Copilot, and LiteLLM
routes. The seed sample uses deterministic office implementations; connecting
those interfaces to live Pi actors is the next increment after the protocol and
actor lifecycle are proven.

The sample runs the durable-storage-contract task from GitHub issue #2 through
two iterations. The first Audit requests a rollback requirement; the second
passes the revised artifact.
