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

The model policy records the intended OpenCode, Codex, Copilot, and direct
MiniMax routes. The seed sample uses deterministic office implementations;
connecting those interfaces to live Pi actors is the next increment after the
protocol and actor lifecycle are proven.

The sample runs the durable-storage-contract task from GitHub issue #2 through
two iterations. The first Audit requests a rollback requirement; the second
passes the revised artifact.

## Live OfficeRunner Adapter

A modular live `OfficeRunner` adapter lives alongside the seed under
`src/`:

| File | Responsibility |
| --- | --- |
| `office-transport.ts` | Public request/response interfaces and capacity-vs-reject error classification. |
| `office-live-transport.ts` | OpenAI-completions LiteLLM gateway transport; base URLs and credentials are injected at runtime only. |
| `office-prompts.ts` | Pure prompt builders for plan/work/audit roles. |
| `office-output.ts` | Pure strict-JSON parsers for the three structured outputs. |
| `live-runner.ts` | Composes transport + prompts + parsers; implements `OfficeRunner`. |

### Routing and fallback semantics

- `ModelPolicy` remains the source of truth for role routes.
- The `minimax-direct` provider routes `minimax-m3` and is backed at runtime
  by an OpenAI-completions LiteLLM gateway. No OpenCode MiniMax route
  appears in source or tests.
- `works` is frontier-only; the fallback `minimax-m3` route is removed from
  the `works` policy. Planning and audit still keep `minimax-m3` as an
  explicit fallback.
- Only explicit quota, capacity, rate-limit, or token-exhaustion signals
  map to `ModelCapacityError` and trigger fallback. Malformed structured
  output, network errors, and arbitrary provider errors raise plain
  errors and never fall back.
- Credentials, base URLs, and bearer header values are runtime-only. They
  never appear in source, tests, or records.

### Runtime caveats (read-only)

- `gpt-5.6-sol` is cataloged for the Codex provider.
- `claude-opus-4.8` is not yet in the runtime catalog; the policy entry
  remains so the catalog is honored once available, but the live runner
  will surface a reject error if no credential is configured.
- `deepseek-v4.1-flash` is currently privacy-blocked; do not assume
  availability even though the policy lists it.
- The `live-runner.ts` adapter is wired through `createLiveRunner`; the
  `sample.ts` continues to use a deterministic office implementation so
  the test suite stays network-free.