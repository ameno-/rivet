# Pi Mate Live Durability Proof

This directory documents the **live proof harness** that exercises the
standalone Pi Mate's native durability and control semantics against a
running Rivet Engine. The harness is **opt-in**: it never starts a
local Engine and never mutates pre-existing actors.

The deterministic unit tests under [`tests/`](../tests/) cover the key
derivation, configuration, credential source, sandbox provider
selection, and the parsed-registry shape. Those are necessary but not
sufficient. The live harness covers the dynamic surface that unit
tests cannot reach: actor sleep, wake, runtime restart, reconnect,
concurrent clients, steer, followUp, abort, model switching,
compaction, and interrupted-call behavior.

## Prerequisites

The harness is operator-driven and refuses to run with a destructive
default. Before the first invocation, the operator must satisfy:

| Variable | Required | Notes |
| --- | --- | --- |
| `RIVET_ENDPOINT` | yes | An **externally managed non-loopback** Rivet Engine. Loopback is rejected. May embed credentials as `http://namespace:token@host:port`. |
| `RIVET_TOKEN` | with auth | The token proof clients authenticate with, injected into the endpoint when the endpoint URL carries no credentials of its own. |
| `RIVET_NAMESPACE` | recommended | Distinct from any Mugamaa namespace. The harness uses it as the actor's namespace. |
| `PI_MATE_OWNER_SCOPE` | yes | Stable opaque slug for the proof run; forms the `ownerScope` segment of the actor key. |
| `PI_MATE_PROJECT_ID` | yes | Stable opaque slug for the proof run; forms the `projectId` segment of the actor key. |
| `PI_MATE_MODEL` | recommended | Default `anthropic/claude-sonnet-4-6`; must be allowed by `PI_MATE_SCOPED_MODELS`. Ignored in faux mode. |
| `PI_MATE_SCOPED_MODELS` | recommended | Comma-separated allowlist. Must include `PI_MATE_MODEL` and the switch target. Ignored in faux mode. |
| `PI_MATE_ANTHROPIC_API_KEY` | real mode | Real Anthropic API key for the configured `anthropic` provider. Not required in faux mode. |
| `PI_MATE_API_KEY_ENV_VARS` | optional | Override the env-var name(s) the credential source reads. |
| `PI_MATE_LIVE_PROOF_FAUX_PROVIDER` | optional | Set to `1` or `true` to run every phase against the in-process faux proof provider instead of a real model. See below. |

Node `>=22.19.0` is required: `@rivet-dev/pi` calls `node:fs.globSync`,
which is only available on Node 22.19+.

The harness must be able to start the standalone runtime
(`pnpm --filter example-pi-mate start`) with the same env. The runtime
itself refuses loopback endpoints, mirroring the constraint.

## Faux proof provider

`PI_MATE_LIVE_PROOF_FAUX_PROVIDER=1` swaps the model runtime for an
in-process scripted provider (built on `@earendil-works/pi-ai`'s public
faux API) registered under the `proof` provider with two models,
`proof/proof-model` and `proof/proof-model-2`. The runtime forces the
model allowlist to those two models regardless of `PI_MATE_MODEL` /
`PI_MATE_SCOPED_MODELS`, and hands the session a labeled non-secret
sentinel credential (`pi-mate-live-proof-faux`) that the credential
source serves **only** to the `proof` provider — never to a real one.
No network call to a model provider is ever made.

Replies are deterministic functions of the prompt text: a prompt
containing the word `slow` streams a long reply slowly (giving the
steering, abort, and interrupted-call phases an in-flight run to act
on); every other prompt receives an immediate reply that echoes the
model id which served it (so the model-switch phase can assert which
model answered).

**Claim boundary.** The faux mode proves the actor's durability and
control semantics — persistence, event fan-out, reconnect, model
switching, steering, abort, compaction, interrupted-call handling —
against a real Rivet Engine. It deliberately does **not** prove the
real provider integration (provider auth, streaming transport, or
upstream model behavior). Every report entry records
`providerMode: "faux"` so a faux run can never masquerade as the real
provider path. Supplying real credentials later requires zero harness
changes: unset the gate, set `PI_MATE_ANTHROPIC_API_KEY`, and rerun.

## Layout

```text
examples/pi-mate/
├── scripts/
│   └── live-proof.ts       # CLI entrypoint (operator-driven)
├── tests/live/
│   ├── proof-harness.ts    # Internal harness helpers (no live Engine required)
│   └── live-shape.test.ts  # Vitest test that runs in dry-run mode
├── src/
│   └── proof-provider.ts   # Config-gated faux proof provider
├── docs/
│   ├── live-proof.md       # This file
│   └── observability.md    # Engine + runtime Prometheus scrape wiring
└── vitest.live.config.ts    # Runs the live-shape suite (pnpm test:live)
```

## Phases

The harness exposes one CLI:

```sh
pnpm --filter example-pi-mate exec tsx scripts/live-proof.ts <phase> [args]
```

The supported phases are:

| Phase | Purpose |
| --- | --- |
| `check` | Validate `RIVET_ENDPOINT` (non-loopback), model creds, scoped models. Probes the Engine with a low-cost HEAD/GET. Does not create an actor. |
| `seed` | Open a fresh actor under a deterministic proof key, run a short deterministic prompt, capture the root conversation id and the first event frame seqs. Writes a `live-proof-report.json` artifact. |
| `verify-key` | Reopen the same actor, confirm the root conversation id is unchanged and that the message history matches the seed artifact. |
| `verify-events` | Open two concurrent connections, `conversation.watchEvents()` on both, and confirm both receive the same event stream for the next prompt. |
| `verify-reconnect` | Close a connection mid-conversation and reopen. Confirm the conversation id survives and the history is unchanged. |
| `verify-model-switch` | Call `conversation.configure` to switch to an allowed model and back. Confirm `conversation.agent().model` reflects each step. |
| `verify-steering` | While a slow run is in flight, send `prompt(..., { whenBusy: "steer" })` and `prompt(..., { whenBusy: "followUp" })`. Confirm both texts are recorded in the transcript exactly once and the queued follow-up runs after the current run completes. |
| `verify-abort` | Start a long prompt, then call `conversation.abort`. Confirm the run settles without an answer, the conversation reaches an idle end state, with no duplicate prompt in the history. |
| `verify-compaction` | Drive the conversation to a large message count and call `conversation.compact`. Confirm a synthetic compaction event is observed and the model context shrinks. |
| `verify-unknown-outcome` | Start a prompt, close the connection before the action resolves. Confirm the action rejects with a connection-class error and the conversation has no duplicate entries after reconnect. |
| `verify-runtime-restart` | Stop the runtime process, restart it, then `verify-key` against the same actor. This phase is **manual** because it requires a supervisor; the harness prints the stop/start commands and a fingerprint to compare. |
| `all` | Runs every phase in dependency order. Skips `verify-runtime-restart` unless `PI_MATE_LIVE_PROOF_ALLOW_RUNTIME_RESTART=1`. |

Each phase emits a single JSON object on stdout. A phase that needs
the seed artifact reads the path from `--report <path>` (default
`./live-proof-report.json`).

## Dry-run guard

If `RIVET_ENDPOINT` is unset, points at a loopback address, or is not
reachable on the operator's network, every phase exits with
`{"phase": "...", "skipped": "dry_run", ...}` and a non-zero exit code.
The vitest test under `tests/live/live-shape.test.ts` runs in this
mode by default and asserts the dry-run shape itself, so CI is green
without a live Engine.

## Actor key isolation

The harness derives the actor key from
`firstMateActorKey({ ownerScope, projectId })`. The owner and project
slugs must be supplied by the operator and uniquely identify the
proof run. Two runs of the harness **must not share a slug** if they
are running against the same Engine and namespace: the harness
deliberately reuses the same key across phases so the durability
checks are meaningful.

## What this harness does not prove

- That the Engine itself is durable: the harness speaks only the
  client protocol and is blind to Engine-side durability contracts.
- That agentOS sandbox composition works: that wiring is filed against
  `mugamaa-jen.4` separately (the agentOS actor must be present in
  the registry, which this proof does not depend on).
- That the runtime survives a host failure: only `verify-runtime-restart`
  exercises the operator-driven restart path.
- That compaction's summary content is correct: the harness only
  verifies that the compaction event was emitted.
- In faux mode, the real provider integration: provider auth, streaming
  transport, and upstream model behavior are never exercised; see
  "Faux proof provider" above.

## Reports

`seed` writes `live-proof-report.json` to the path supplied by
`--report`. The report contains:

- the actor key,
- the actor id (resolved by the Engine),
- the session id,
- the first 8 event ids,
- the message count after the seed prompt,
- the model in use,
- the wall-clock timestamps for the seed phase.

Subsequent phases extend the report with their own observations. The
harness never writes to a path that is not explicitly supplied, and it
never reads the report's `secret`-shaped fields.
