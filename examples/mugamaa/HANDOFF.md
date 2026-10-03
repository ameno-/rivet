# Mugamaa Persistent Supervisor Handoff

Use this document as the prompt and execution brief for the next implementation
agent. It is intentionally prescriptive about lifecycle and safety boundaries.

## Handoff prompt

You are taking over development of Mugamaa in the Rivet monorepo.

Your mission is to replace the temporary Pi CLI execution path with a deployed
Rivet Actor runtime supervised by a durable Mugamaa Supervisor actor. Build the
smallest persistent, restartable control plane that can accept one Goal Charter,
dispatch one Case actor through Planning, Works, Audit, and Decision offices,
survive runtime restarts without duplicating ambiguous model or tool work, and
produce an inspectable product/process receipt.

Do not begin by adding inbox, ticketing, Linear, Beads, UI, multi-tenant global
coordination, or production high availability. First prove one workspace, one
supervisor, one case, and actor-backed Pi offices end to end.

### Required alignment before broad implementation

Confirm these choices with the owner. Recommended defaults are included so the
architecture remains concrete:

1. **Deployment objective:** dogfood-first on `agent-core`, not immediate
   machine-loss high availability. Use recoverable persistent volumes and clear
   backup boundaries. Do not add Kubernetes.
2. **Supervisor scope:** one stable Supervisor actor per workspace/project. Do
   not create one global actor that owns every repository and case.
3. **Authority policy:** autonomous local inference, actor state changes,
   sandbox work, tests, and local commits; require approval for pushes, issue
   closure, deployment, destructive operations, and other irreversible external
   effects unless the owner grants a narrower exception.

If the owner changes one of these answers, update the architecture record and
tests before extending implementation. Do not silently infer broader authority.

## Repository and branch

- Repository: `https://github.com/ameno-/rivet`
- Feature branch: `feat/pi-durable-rivet-bootstrap`
- Remote agent-core checkout:
  `/home/ameno/Projects/mugamaa-live-offices`
- Validated local Engine binary used by existing tests:
  `/home/ameno/Projects/rivet-pi-durable/target/debug/rivet-engine`
- GitHub issue used for the first live case:
  `https://github.com/ameno-/rivet/issues/2`

This repository uses Jujutsu colocated with Git. Before editing:

```sh
cd /home/ameno/Projects/mugamaa-live-offices
nix shell nixpkgs#jujutsu -c jj status
nix shell nixpkgs#jujutsu -c jj new
nix shell nixpkgs#jujutsu -c jj describe -m "feat(mugamaa): <change>"
```

Do not use raw `git commit`. Use the repository's Jujutsu workflow and the
machine `committer` helper whenever a Git commit is required by the surrounding
workflow. Never force-push. Keep unrelated user/agent changes intact.

## What already works

The current branch contains a tested Mugamaa seed:

- `examples/mugamaa/src/actor.ts`
  - Rivet Actor with distinct durable workflow steps for initialization,
    Planning, Works, Audit, Decision, and exhaustion.
  - Model steps use `maxRetries: 0` and no timeout.
  - Completed workflow steps replay from history; ambiguous model work is not
    supposed to be silently reissued.
- `examples/mugamaa/src/phases.ts`
  - Shared phase semantics used by the actor and direct engine.
  - Capacity-only fallback and parallel primary audits.
- `examples/mugamaa/src/pi-office-runner.ts`
  - Structural bridge from Mugamaa's `OfficeRunner` interface to four Pi actor
    actions: `setModel`, `setThinkingLevel`, `prompt`, and
    `getLastAssistantText`.
  - Deterministic office keys and strict JSON parsing.
- `examples/mugamaa/src/model-policy.ts`
  - Planning: `opencode-go/kimi-k3`, medium thinking.
  - Works: `opencode-go/grok-4.7`, medium thinking.
  - Audit primaries: `opencode-go/glm-5.3-flash` at medium and
    `opencode-go/grok-4.7` at low, in parallel.
  - Capacity-only fallback: `minimax-direct/minimax-m3` at low.
  - No default GPT, Codex, or Copilot route.
- `examples/mugamaa/src/operator-cli.ts`
  - Manual `run` and `inspect` commands with charter validation and atomic case
    receipts.
- `examples/mugamaa/src/pi-cli-transport.ts`
  - Temporary dogfood transport. It safely proved live model routing, but it is
    not the target architecture.
- `examples/mugamaa/cases/github-ameno-rivet-2-live-2.*`
  - Accepted live charter and complete product/process receipt.

Validated baseline before this handoff:

- Biome passed.
- TypeScript passed.
- 157 deterministic Mugamaa tests passed.
- Isolated Rivet Actor test passed.
- Kimi, Grok, GLM, and direct MiniMax routes produced live responses.
- Independent GLM audit reported no high-severity findings.

## Claims that are not yet true

Do not describe Mugamaa as fully persistent or autonomous yet.

- Live model calls currently run through a child Pi CLI process, not a Pi actor.
- The durable Case actor and the live model route were validated separately;
  they have not been joined in a process-kill recovery test.
- No persistent Supervisor actor exists.
- No production server/runtime deployment exists.
- No first-class supervisor veto/revision action exists. The accepted issue #2
  case required issuing a corrected second charter after both model audits
  approved a semantically wrong first draft.
- Failed operator runs do not yet guarantee a persisted partial failure receipt.
- Inbox, ticketing, Linear, Beads, and a separate Records Office are deferred.
- Machine-loss recovery and multi-node high availability are deferred.

## Architectural decision

Mugamaa needs both an Engine service and an application runtime:

```text
Client / thin HTTP API
          |
          v
Workspace Supervisor actor (stable key: workspace identity)
          |
          +---- Case actor (stable key: case id)
          |       |
          |       +---- Planning Office actor attempt
          |       +---- Works Office actor attempt
          |       +---- Audit Office actor attempts
          |
          +---- policy, admission, deadlines, escalation, summaries

Rivet Engine
  scheduling, routing, actor persistence, wake/sleep, queues, workflows

Mugamaa runtime
  Node/Bun process hosting the registry and HTTP handler
```

Persistence means stable actor identity plus durable state. It does **not** mean
an immortal process. Rivet Actors may sleep, wake, restart, and run in a new
generation. The application must recover from durable state and queues.

### Engine service

Run Rivet Engine as an externally managed, pinned release binary or container.
It owns control-plane durability, scheduling, routing, actor wake/sleep, queues,
and workflow history.

Do not let tests or the application runtime auto-start production Engine
processes. Previous one-shot tests leaked multiple local Engine processes and
port families. The deployed runtime must use `startEngine = false` and connect
to the externally managed endpoint through RivetKit's normal configuration.

### Mugamaa runtime

Create a backend-only runtime with the repository's standard example layout:

```text
examples/mugamaa/
  src/
    actors.ts       # registry and actor definitions
    server.ts       # HTTP handler and health/readiness
    runtime.ts      # standalone external-Engine entry point if needed
```

The runtime must:

- export one `registry` built with `setup({ use: ... })`;
- expose `/api/rivet/*` through `registry.handler(...)` when using an HTTP
  server deployment;
- expose `/health` and a readiness check that does not return ready before the
  registry is ready;
- use standard `RIVET_ENDPOINT` resolution rather than inventing duplicate
  endpoint, namespace, token, or pool configuration;
- start with `registry.startAndWait()` for the standalone native runtime;
- shut down cleanly on process termination;
- keep credentials and provider URLs in runtime configuration only.

For initial agent-core dogfooding, use two independently restartable services:

1. `rivet-engine` with persistent storage.
2. `mugamaa-runtime` pointing at that Engine.

A small Compose stack or user-level systemd services are acceptable. Prefer a
reproducible pinned configuration. Do not grant the Supervisor actor direct
host shell access merely because developer tools are installed on agent-core.

## Actor responsibilities

### Workspace Supervisor actor

One Supervisor actor per workspace/project. Suggested stable key:

```text
workspace/<workspace-id>
```

The Supervisor is a control-plane actor, not a worker. It owns:

- admission of Goal Charters;
- deterministic case ids and idempotency keys;
- case index and current status summary;
- policy version selected for each case;
- budgets, deadlines, pause state, and authority gates;
- reconciliation/escalation state;
- commands to Case actors;
- schedules or cron needed to revisit blocked/stalled cases;
- supervisor decisions and their reasons.

It must not:

- call models directly;
- mutate repositories directly;
- own shell or unrestricted filesystem tools;
- keep an infinite polling loop alive;
- duplicate the authoritative Case record stream;
- silently retry an ambiguous Office operation.

Use a durable queue for submitted work and control commands. Let the actor sleep
when idle. Queues, schedules, and cron should wake it when needed.

Minimum actions/commands:

- `submitCharter(charter, idempotencyKey)`
- `getCase(caseId)`
- `listCases(filter)`
- `pauseCase(caseId, reason)`
- `resumeCase(caseId, reason)`
- `requestRevision(caseId, findings, reason)`
- `cancelCase(caseId, reason)`
- `reconcileAttempt(caseId, attemptId, decision)`

Minimum events:

- `caseAccepted`
- `caseStatusChanged`
- `caseNeedsReconciliation`
- `caseCompleted`
- `caseBlocked`
- `supervisorDecisionRecorded`

Persist commands and decisions before dispatching their effects. Repeated
commands with the same idempotency key must return the prior result.

### Case actor

One stable Case actor per Goal Charter. The existing actor is the starting
point. It remains authoritative for:

- charter snapshot and policy version;
- workflow iteration and current phase;
- Work Order, Product Artifact, audit verdicts, and final outcome;
- ordered Product and Process records;
- Office attempt ids and reconciliation status.

The Supervisor stores only an index/summary. Do not require a distributed
transaction between Supervisor and Case actors. Case commits first; summary
delivery to Supervisor is idempotent and may be retried.

Add an explicit nonterminal state such as `needs_reconciliation` for an Office
call that may have reached a provider but lacks a durable completion receipt.
Never convert ambiguity into an automatic retry.

### Pi Office actors

Replace the CLI transport with `@rivet-dev/pi` actors and the existing
`createPiOfficeRunner` bridge. Office actor keys must identify exactly one
logical attempt, for example:

```text
<case-id>/<iteration>/planning/<attempt-id>
<case-id>/<iteration>/works/<attempt-id>
<case-id>/<iteration>/audit/<provider>/<model>/<attempt-id>
```

Requirements:

- resolve a real Rivet client handle implementing the current
  `PiOfficeHandle` contract;
- bind application-provided provider credentials and model configuration;
- do not read Pi login files inside actors;
- preserve the sequence `setModel` -> `setThinkingLevel` -> `prompt` ->
  `getLastAssistantText`;
- use strict JSON parsers already present;
- execute each model attempt once;
- map only explicit capacity/quota/token-exhaustion failures to fallback;
- treat malformed output, transport failure, and ambiguous interruption as
  reject/block/reconcile, not fallback;
- keep audit primaries independently keyed and parallel;
- never use OpenCode for MiniMax; `minimax-direct/minimax-m3` is the fallback.

Do not remove the Pi CLI transport until the actor-backed end-to-end test and
restart test pass. Then deprecate or delete it in a separate reviewable change.

### Inference Coordinator

Start as a small configuration/service boundary, not another actor unless it
needs durable shared capacity or budget state.

It owns:

- role -> ordered model routes;
- provider credential injection;
- accepted thinking levels (`low` or `medium`);
- capacity classification vocabulary;
- policy versioning;
- route readiness/preflight;
- future per-provider concurrency and budget limits.

The Supervisor records the selected policy version. The Case actor records the
exact route used by every successful or exhausted attempt.

### Records

Keep the complete ordered record stream in the Case actor's transactional state
for this increment. This guarantees the product artifact and the process used
to create it commit together.

Later, export records asynchronously to a Records Office/search/index actor.
The export must be idempotent by `(caseId, seq)`. Do not make case progress
depend on a distributed write to a separate Records actor now.

## Lifecycle and failure invariants

These are non-negotiable:

1. Stable ownership belongs to the Rivet Actor and its durable state across
   generations. The current generation is only the active executor.
2. Every external effect has a deterministic attempt/idempotency id persisted
   before dispatch.
3. A completed workflow step may replay its stored result, not its external
   call.
4. An interrupted model/tool call with unknown outcome becomes
   `needs_reconciliation`.
5. No potentially mutating tool is silently replayed after runtime or actor
   restart.
6. Supervisor and Case actors may sleep when idle; no heartbeat polling loop is
   required to prove persistence.
7. Runtime restart, Engine restart, actor sleep/wake, and provider failure are
   distinct tests.
8. Product records and process records remain ordered and inspectable.
9. Credentials, bearer headers, provider URLs, and local secret paths never
   enter actor state, receipts, logs, fixtures, or errors.
10. Authority is capability-scoped. The Supervisor dispatches work; it does not
    inherit unrestricted worker capabilities.

## Implementation sequence

Keep each slice independently testable and commit it separately.

### Slice 1: deployable registry/runtime

- Create `src/actors.ts`, register the existing Case actor, and export
  `registry`.
- Create `src/server.ts` with Rivet handler plus health/readiness.
- Create the standalone external-Engine entry point if the server adapter does
  not own registry startup.
- Add package scripts for dev, build, start, typecheck, and tests following the
  repository example conventions.
- Run against an externally managed local Engine with `startEngine = false`.

Exit evidence: a client creates a deterministic Case actor and reads its
snapshot through the deployed runtime after a runtime restart.

### Slice 2: Supervisor protocol

- Implement one Supervisor actor per workspace.
- Add durable submission/control queues and idempotency tables/state.
- Add case index, status events, pause/resume/cancel/revision/reconcile actions.
- Dispatch to Case actors without copying their full records.

Exit evidence: duplicate submission produces one Case actor; runtime restart
does not duplicate dispatch; supervisor can inspect the same case afterward.

### Slice 3: actor-backed Office resolver

- Implement the real `PiOfficeActorResolver` using the existing Pi integration.
- Wire model policy and runtime credential injection.
- Keep CLI path available only as an explicit development fallback while
  validating parity.

Exit evidence: one Planning call runs through a Pi actor, records its exact
route, and returns a strictly parsed Work Order without spawning `pi`.

### Slice 4: full live case

- Run issue #2 or an equivalent bounded charter through Supervisor -> Case ->
  Pi Office actors.
- Preserve parallel GLM/Grok audit behavior.
- Exercise a supervisor-requested revision through the same Case actor rather
  than issuing a second charter.

Exit evidence: terminal receipt includes submission, dispatch, phase, route,
audit, supervisor decision, and completion records.

### Slice 5: restart and ambiguity harness

- Kill the runtime between completed phases and verify resume from workflow
  history.
- Kill during an Office call after dispatch but before completion is persisted.
- Verify the case becomes `needs_reconciliation` and does not invoke the model
  again automatically.
- Restart the Engine with persistent storage and verify actor state remains.
- Exercise actor sleep/wake separately.

Exit evidence: invocation counters and receipts prove no duplicate model or
tool effects.

### Slice 6: retire Pi CLI runtime path

- Remove the Pi CLI runner from production wiring only after parity and restart
  evidence pass.
- Keep or delete the transport as a separate decision; do not leave it as an
  implicit fallback.
- Update README claims to match proven behavior.

## Required companion runbook

Before implementation, read `HANDOFF_RUNBOOK.md` in this directory. It contains
the exact existing test gate, native actor isolation command, required new test
layers, operational cautions, and takeover definition of done. Treat it as part
of this prompt, not optional background.

## First recommended action

After confirming the three alignment decisions, implement Slice 1 only:

1. Produce the deployable registry/server/runtime skeleton.
2. Run it against one externally managed Engine on agent-core.
3. Prove a deterministic Case actor survives runtime restart.
4. Stop and report the receipt, service topology, commands, and remaining
   uncertainty before wiring live Pi actors.

Walking this sequence prevents the supervisor, model runtime, deployment
runtime, and worker capabilities from becoming one untestable process.
