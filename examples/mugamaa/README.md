# The Mugamaa

Mugamaa Seed is the smallest working form of the factory: one Goal Charter,
one bounded plan-work-audit loop, append-only records, and an inspectable final
verdict.

The seed intentionally has no inbox, ticket adapter, repository mutation, or
parallel case scheduling. Office implementations are injected. Tests use
deterministic scripted offices. The manual operator can now use isolated Pi
CLI workers; a later adapter can bind the same protocol to live Pi actor
handles and the Inference Coordinator.

The next implementation increment is specified in
[`HANDOFF.md`](./HANDOFF.md). Its required verification and operational gates
are in [`HANDOFF_RUNBOOK.md`](./HANDOFF_RUNBOOK.md).

```sh
pnpm --filter example-mugamaa check-types
RIVET_ENGINE_BINARY="$PWD/target/debug/rivet-engine" \
  pnpm --filter example-mugamaa test
pnpm --filter example-mugamaa sample
```

The model policy records the intended OpenCode-go and direct MiniMax
routes. The default policy resolves to verified Kimi, Grok, and GLM
models through the OpenCode-go provider, with `minimax-direct/minimax-m3`
as the sole fallback. Codex, OpenAI Codex, and Copilot provider entries
remain on the type for adapter extensibility but never appear in the
default policy. The seed sample remains deterministic. The manual operator has
a live Pi CLI runner; connecting those interfaces to live `@rivet-dev/pi`
actor handles is the next increment after the protocol and actor lifecycle are
proven.

The sample runs the durable-storage-contract task from GitHub issue #2 through
two iterations. The first Audit requests a rollback requirement; the second
passes the revised artifact.

## Phase-durable Actor

The Rivet Actor commits one workflow step for initialization and separate
Planning, Works, Audit, and Decision steps for every iteration. Product and
Process records created by a phase are stored in actor state before the next
phase begins. The in-memory `Mugamaa.run()` path uses the same phase helpers, so
the actor and direct runner retain identical routing, fallback, verdict, and
record-ordering behavior.

Planning, Works, and Audit steps use `maxRetries: 0` and no timeout. Completed
steps replay from Rivet workflow history; an interrupted or ambiguous model
action blocks the workflow instead of being silently issued again. Focused
tests cover every phase, terminal decision, record ordering, helper parity, and
single-attempt error behavior. The one-shot actor test uses an isolated
`RIVETKIT_STORAGE_PATH` and engine port because reusing the shared local engine
database can wake stale test actors. A process-kill-and-reopen harness remains
required before claiming live crash recovery.

## Manual Operator Commands

The operator runs exactly one explicit Goal Charter with an explicitly supplied
runner module and stores the complete CaseState receipt locally:

```sh
pnpm mugamaa run ./charter.json \
  --runner-module ./runner.ts \
  --records-dir ./.mugamaa/records

pnpm mugamaa inspect <case-id> \
  --records-dir ./.mugamaa/records
```

The runner module must export either `runner: OfficeRunner` or
`createRunner(): OfficeRunner | Promise<OfficeRunner>`. Mugamaa never loads an
ambient runner. Charter shape, case IDs, runner exports, and stored receipts are
validated at runtime. Receipts are written through a sibling temporary file and
an atomic rename, and contain case state only—never credentials, provider URLs,
or bearer headers.

### Pi-backed operator

`src/pi-cli-runner.ts` is an explicit runner module for local dogfooding. Each
office call starts one isolated, non-interactive Pi process with no tools,
extensions, skills, prompt templates, context files, session persistence, or
project-file approval:

```sh
PI_CODING_AGENT_DIR=/path/to/reviewed/pi-config \
MUGAMAA_PI_EXECUTABLE=/absolute/path/to/pi \
pnpm mugamaa run ./charter.json \
  --runner-module ./src/pi-cli-runner.ts \
  --records-dir ./.mugamaa/records
```

The Pi configuration must register every provider named by the model policy.
For the default policy that means the OpenCode Go routes plus a
`minimax-direct/minimax-m3` provider backed by the direct MiniMax subscription.
The child inherits provider authentication at runtime; neither configuration
nor credentials enter the persisted receipt. Pi output is byte-bounded, model
calls are never retried by the transport, and only explicit capacity evidence
activates policy fallback.

### First live case

`cases/github-ameno-rivet-2-live-2.charter.json` and its adjacent `.case.json`
receipt preserve the first supervisor-accepted dogfood result for GitHub issue
2. Kimi K3 planned, Grok 4.7 produced the contract, and GLM 5.3 Flash plus Grok
4.7 audited it in parallel. The receipt reached `completed` in one iteration
with nine ordered product/process records and no fallback route.

The first draft is intentionally not checked in: both model audits passed it,
but supervisor review caught that it assigned storage ownership to an actor
generation. The accepted case explicitly assigns ownership to the stable Rivet
Actor and its SQLite database across generations; only the active generation
holds the exclusive writer lease. This is evidence that model audit consensus
does not replace supervisor authority. A first-class supervisor veto/revision
input remains future work; this run used a corrected second charter.

## Live OfficeRunner Adapter

A modular live `OfficeRunner` adapter lives alongside the seed under
`src/`:

| File | Responsibility |
| --- | --- |
| `office-transport.ts` | Public request/response interfaces and capacity-vs-reject error classification. |
| `office-live-transport.ts` | OpenAI-completions LiteLLM gateway transport; base URLs and credentials are injected at runtime only. |
| `pi-cli-transport.ts` | Isolated one-shot Pi CLI transport with bounded output and capacity classification. |
| `office-prompts.ts` | Pure prompt builders for plan/work/audit roles. |
| `office-output.ts` | Pure strict-JSON parsers for the three structured outputs. |
| `live-runner.ts` | Composes transport + prompts + parsers; implements `OfficeRunner`. |

### Routing and fallback semantics

- `ModelPolicy` remains the source of truth for role routes.
- The `opencode-go` provider fronts Kimi K3, Grok 4.7, and GLM 5.3 Flash
  through a single OpenAI-completions gateway. `minimax-direct` is the
  sole fallback provider and routes `minimax-m3`. No OpenCode MiniMax
  route appears in source or tests; the direct provider is reserved for
  capacity recovery only.
- `planning` tries `opencode-go/kimi-k3` first (medium thinking) and
  falls back to `minimax-direct/minimax-m3` (low thinking) only when
  the primary is exhausted by a `ModelCapacityError`.
- `works` tries `opencode-go/grok-4.7` first (medium thinking) and falls
  back to `minimax-direct/minimax-m3` (low thinking, capacity only) under
  the same classification rule.
- `audit` runs `opencode-go/glm-5.3-flash` (medium thinking) and
  `opencode-go/grok-4.7` (low thinking) in parallel. If every primary
  reports capacity exhaustion, `minimax-direct/minimax-m3` runs as the
  single fallback.
- The live runner validates the route's `thinking` value at the runner
  boundary and accepts only `"low"` and `"medium"`. Any other runtime
  value (cast, JSON-derived, otherwise malformed) is rejected before the
  transport is called; the runner never silently clamps to a default.
- Only explicit quota, capacity, rate-limit, or token-exhaustion signals
  map to `ModelCapacityError` and trigger fallback. Malformed structured
  output, network errors, and arbitrary provider errors raise plain
  errors and never fall back.
- Credentials, base URLs, and bearer header values are runtime-only. They
  never appear in source, tests, or records.

### Runtime caveats (read-only)

- `kimi-k3`, `grok-4.7`, and `glm-5.3-flash` are cataloged through the
  `opencode-go` provider.
- `minimax-m3` is the verified direct provider route and is reserved for
  capacity-only fallback; the live runner never enters this route on a
  successful primary.
- The `live-runner.ts` adapter is wired through `createLiveRunner`; the
  `sample.ts` continues to use a deterministic office implementation so
  the test suite stays network-free.
