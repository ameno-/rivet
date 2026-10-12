# Standalone Rivet Pi Mate

A minimal Rivet service that hosts one durable Pi Actor — the **Pi Mate** —
under a stable, four-segment actor key. It is intentionally independent
of Mugamaa and of Centaur's `pi.rs` harness: there is no Mugamaa actor,
credential, or namespace, and no Centaur `stateVolume`.

The Mate uses the native `@rivet-dev/pi` integration, so it inherits:

- `prompt` with `requestId` idempotency and `whenBusy` steering modes
- the namespaced Pi Durable actions (`harness.*`, `conversation.*`,
  `submission.*`): watch, abort, compact, configure, model switching,
  entries, tasks
- native event streaming over the actor's `pi.events` watch channel
- SQLite-backed conversation, submission, and task durability owned by
  the actor itself

Credentials are pulled from the operator's secret store at call time
through a `PiCredentialSource` that reads API keys from environment
variables. The optional file and shell sandbox the Pi session uses is
built from a [`@rivet-dev/sandbox-adapter`](../../shared/typescript/sandbox-adapter/)
provider selected by config. No secret, API key, sandbox endpoint, or
package URL is ever copied into actor state, fixtures, or logs.

## Layout

```text
examples/pi-mate/
├── package.json
├── tsconfig.json
├── turbo.json
├── vitest.config.ts
├── src/
│   ├── actors.ts        # Pi Mate actor definition + registry factory
│   ├── index.ts         # Public surface re-exports
│   ├── backend-info-tool.ts  # pi_mate_backend_info custom tool definition
│   ├── config.ts        # Key derivation, scoped models, sandbox provider config
│   ├── credentials.ts   # Runtime-injected credential source
│   ├── sandbox.ts       # Sandbox provider factory (sandbox-adapter)
│   ├── health.ts        # /health and /ready endpoints
│   ├── metrics.ts       # /metrics endpoint (Prometheus scrape)
│   ├── runtime.ts       # Standalone runtime (envoy mode)
│   └── server.ts        # Handler-mode HTTP server (dev)
├── scripts/
│   └── client.ts        # Typed client round-trip
├── docs/
│   └── observability.md # Engine + runtime scrape wiring and dashboard
└── tests/
    ├── config.test.ts
    ├── credentials.test.ts
    ├── sandbox.test.ts
    └── registry.test.ts
```

## Stable first-mate key

The Mate actor is addressed by a fixed four-segment tuple derived from
the integrator's owner scope, project id, and thread id (the thread
segment partitions conversations; see ADR-0002):

```text
["mate", owner_scope, project_id, thread_segment]
```

`ownerScope` and `projectId` are opaque, normalized slugs (lowercase
`[a-z0-9-_]`, max 63 chars). The key shape is the durable identity of
the Mate's session; Slack thread timestamps and similar delivery
context are not part of it.

The first segment is fixed to `"mate"`. Two different `(owner, project)`
pairs always produce different keys.

## Configuration

Environment variables consumed by `loadPiMateConfig()` and the Rivet
runtime:

| Variable | Default | Purpose |
| --- | --- | --- |
| `RIVET_ENDPOINT` | required | Engine endpoint; loopback is rejected by the runtime |
| `RIVET_NAMESPACE` | `default` | Rivet namespace; the operator picks one distinct from Mugamaa's |
| `PI_MATE_NAMESPACE` | `pi-mate` | Documented namespace for the Mate service (advisory) |
| `PI_MATE_MODEL` | `anthropic/claude-sonnet-4-6` | Opening model for new sessions |
| `PI_MATE_SCOPED_MODELS` | the default model pair | Comma-separated allowlist for `conversation.configure` model switches |
| `PI_MATE_ANTHROPIC_API_KEY` | required at runtime | API key for the `anthropic` provider |
| `PI_MATE_API_KEY_ENV_VARS` | the `anthropic` env var | Comma-separated env var names the source reads |
| `PI_MATE_ENABLE_BACKEND_INFO_TOOL` | off | Gates the `pi_mate_backend_info` custom tool. Off by default; set to `1` or `true` to enable. |

Sandbox provider env vars consumed by `loadSandboxProviderConfig()`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_MATE_SANDBOX_PROVIDER` | `none` | One of `none`, `agentos`, `daytona`, `e2b` |
| `PI_MATE_SANDBOX_CWD` | per-provider | Absolute working directory inside the sandbox |
| `PI_MATE_SANDBOX_AGENTOS_SOFTWARE` | required for `agentos` | Comma-separated agentOS package URLs (optionally suffixed `#digest`) |
| `PI_MATE_SANDBOX_DAYTONA_API_KEY_ENV_VAR` | `DAYTONA_API_KEY` | Env var name the daytona provider reads |
| `PI_MATE_SANDBOX_E2B_API_KEY_ENV_VAR` | `E2B_API_KEY` | Env var name the e2b provider reads |
| `PI_MATE_SANDBOX_E2B_TEMPLATE` | `base` | E2B template id or name |

Credentials are read fresh on every `read()` call, so the deployed
service picks up rotated secrets without a restart. No secret is ever
written to actor state, fixtures, logs, or Pi messages.

## Sandbox provider

The Pi Mate registry forwards every file and shell call from Pi's
built-in tools through a `SandboxProvider` built by
`buildSandboxProvider(config.sandbox)` and passed to `pi({ sandbox })`.
The provider is constructed once at registry build time; nothing about
it is persisted in actor state.

| `PI_MATE_SANDBOX_PROVIDER` | Behavior |
| --- | --- |
| `none` (default) | Pi runs without file or shell tools. |
| `agentos` | Routes tools through `agentOSProvider` from `@rivet-dev/sandbox-adapter`. Requires `PI_MATE_SANDBOX_AGENTOS_SOFTWARE` to list at least one package URL. The agentOS VM actor must be present in the same registry; that composition is filed against `mugamaa-jen.4`. |
| `daytona` | Routes tools through `daytonaProvider`. Requires `DAYTONA_API_KEY` (or the operator-overridden env var) to be set. |
| `e2b` | Routes tools through `e2bProvider`. Requires `E2B_API_KEY` (or the operator-overridden env var) to be set. |

A misconfigured provider (missing software, missing API key) fails
closed at registry build time: `buildSandboxProvider` throws
`PiMateSandboxConfigError` and the runtime never starts.

## Prerequisites

The full Pi Actor lifecycle (prompt with idempotent retries, whenBusy
steering, abort, native events, durability across sleep/wake) requires:

- Node `>=22.19.0` (the `@rivet-dev/pi` package depends on the NAPI
  binding exposed by `rivetkit`)
- A built `@rivetkit/rivetkit-napi` artifact in this workspace
- An externally managed Rivet Engine at `RIVET_ENDPOINT`
- A valid model API key reachable by the deployed process
- For `PI_MATE_SANDBOX_PROVIDER=agentos`: an agentOS VM actor
  compositioned into the registry (filed against `mugamaa-jen.4`)
- For `PI_MATE_SANDBOX_PROVIDER=daytona|e2b`: the matching provider
  SDK installed (`@daytonaio/sdk` or `e2b`) and the API key env var set

### Node version

The unit test suite imports `@rivet-dev/pi`, which calls
`node:fs.globSync`. `globSync` is only available on Node `>=22`. On
older Node releases the registry, integration-shape, and Pi-coupled
test files fail to load with
`SyntaxError: The requested module 'node:fs' does not provide an export
named 'globSync'`. The engine pin in `package.json` is left at
`>=22.19.0`; the host Node version is documented here as a live
prerequisite rather than weakening the constraint.

The pure config, credentials, and sandbox-provider factory tests
(`tests/config.test.ts`, `tests/credentials.test.ts`,
`tests/sandbox.test.ts`) do not import `@rivet-dev/pi` and pass on
Node 20+.

The unit test suite shipped here (`pnpm --filter example-pi-mate test`)
runs without a live Engine and covers key derivation, configuration
validation, credential-source behavior, and sandbox-provider selection
end to end. The live prerequisite is verified by the parent issue
`mugamaa-jen.4`.

## Getting Started

```sh
# Type-check
pnpm --filter example-pi-mate check-types

# Run the unit tests
pnpm --filter example-pi-mate test

# Run the handler-mode dev server (lazy runtime, sandbox disabled)
pnpm --filter example-pi-mate dev

# Run the standalone runtime (requires a live Engine + the env vars above)
RIVET_ENDPOINT=http://agent-core-lan:6420 \
PI_MATE_ANTHROPIC_API_KEY=... \
pnpm --filter example-pi-mate start

# Run the typed client smoke path against a running service
RIVET_ENDPOINT=http://127.0.0.1:6423 \
PI_MATE_OWNER_SCOPE=demo PI_MATE_PROJECT_ID=demo \
pnpm --filter example-pi-mate client
```

To enable a sandbox:

```sh
# agentOS: requires the agentOS VM actor in the same registry (mugamaa-jen.4)
PI_MATE_SANDBOX_PROVIDER=agentos \
PI_MATE_SANDBOX_AGENTOS_SOFTWARE=https://example.test/common.tgz#sha256-abc \
pnpm --filter example-pi-mate start

# daytona: uses DAYTONA_API_KEY from the operator's secret store
PI_MATE_SANDBOX_PROVIDER=daytona \
DAYTONA_API_KEY=... \
pnpm --filter example-pi-mate start

# e2b: uses E2B_API_KEY from the operator's secret store
PI_MATE_SANDBOX_PROVIDER=e2b \
E2B_API_KEY=... \
pnpm --filter example-pi-mate start
```

## Features

- Standalone Rivet service, no Mugamaa dependency.
- One Pi Actor behind a fixed four-segment key
  `["mate", owner, project, thread]` (the thread segment partitions
  conversations; see ADR-0002).
- Native Pi Durable action surface inherited from `@rivet-dev/pi`:
  `prompt` with `requestId` idempotency and `whenBusy` steering modes,
  plus `harness.*`, `conversation.*`, and `submission.*` actions
  (watch, abort, compact, configure, model switching, entries, tasks).
- Native event streaming over the actor's `pi.events` watch channel
  (`pi.view`, `pi.taskGraph`, and `pi.doc` channels alongside).
- SQLite-backed conversation, submission, and task durability owned by
  the actor itself: runs survive worker restarts and resume where they
  left off, so a killed worker generation never loses or duplicates a
  prompt.
- One scoped, read-only backend-info custom tool
  (`pi_mate_backend_info`) installed into the Pi Durable harness
  registry through an extension. The tool is feature-gated by
  `PI_MATE_ENABLE_BACKEND_INFO_TOOL` (off by default), validates its
  arguments against a strict schema, caps its result to a deterministic
  byte budget, and honors Pi's cancellation signal. It only ever
  exposes data scoped to the calling actor's own backend context.
- Runtime-injected credentials via `PiCredentialSource`; no secrets in
  actor state, fixtures, or logs.
- Optional sandbox provider selected by
  `PI_MATE_SANDBOX_PROVIDER` (`none`, `agentos`, `daytona`, `e2b`)
  built on the native `@rivet-dev/sandbox-adapter` providers; credentials
  and endpoints stay out of actor state, fixtures, and logs.
- Loopback Engine endpoints are rejected by the deployed runtime.

## Custom tool: `pi_mate_backend_info`

A scoped, read-only tool the Mate actor exposes to Pi so the model can
inspect a bounded, redacted snapshot of its own backend context without
ever touching the host environment, the upstream services, or the
credential store.

| Property | Value |
| --- | --- |
| Tool name | `pi_mate_backend_info` |
| Arguments | `{ note?: string (1-64 chars) }`; `additionalProperties` rejected |
| Env gate | `PI_MATE_ENABLE_BACKEND_INFO_TOOL`; accepts `1` or `true` (case-insensitive) |
| Disabled behavior | Returns `isError: true` with the gate name in the message |
| Output cap | 4 096 bytes (`BACKEND_INFO_TOOL_MAX_RESULT_BYTES`); deterministic truncation marker |
| Exposed fields | `sessionId` (the calling conversation's durable id), `modelAllowlistSize`, `sandboxProviderName`, `backendInfoToolEnabled`, optional `note`, `generatedAt` |
| Redacted | model ids, model list, API key env var names, agentOS URLs, sandbox provider env var overrides, cwd, full session transcript |
| Cancellation | Honors the call's `AbortSignal`; throws when already aborted |
| Capabilities denied | file, network, or agent; the tool returns text and never holds handles |

## Implementation

- [Pi Mate source on GitHub](https://github.com/rivet-dev/rivet/tree/main/examples/pi-mate)
- [`src/actors.ts`](./src/actors.ts) — Pi Mate actor definition and registry factory; installs the
  `pi_mate_backend_info` tool into the Pi Durable harness registry through
  the `pi-mate-tools` extension.
- [`src/backend-info-tool.ts`](./src/backend-info-tool.ts) — definition of the
  `pi_mate_backend_info` custom tool, the env-var gate, the bounded snapshot
  builder, and the deterministic truncation logic.
- [`src/config.ts`](./src/config.ts) — key derivation, namespace helper, scoped
  models, sandbox provider config, env-var gate constant, and log-safe redaction.
- [`src/credentials.ts`](./src/credentials.ts) — env-backed `PiCredentialSource`.
- [`src/sandbox.ts`](./src/sandbox.ts) — sandbox provider factory built on
  `@rivet-dev/sandbox-adapter`; fail-closed on missing configuration.
- [`src/health.ts`](./src/health.ts) — `/health` and `/ready` endpoints shared
  by the dev server and the standalone runtime.
- [`src/runtime.ts`](./src/runtime.ts) — standalone runtime; refuses loopback
  Engine endpoints.
- [`src/server.ts`](./src/server.ts) — handler-mode dev server.
- [`src/index.ts`](./src/index.ts) — public surface re-exports.
- [`scripts/client.ts`](./scripts/client.ts) — typed client round-trip.
- [`tests/`](./tests/) — deterministic unit tests for key derivation,
  configuration validation, credential source, sandbox provider
  selection, registry shape, and the `pi_mate_backend_info` tool.

## Resources

- [RivetKit docs](https://rivet.dev/docs)
- [`@rivet-dev/pi` integration](../../integrations/pi/)
- [`@rivet-dev/sandbox-adapter`](../../shared/typescript/sandbox-adapter/)
- [ADR-0001: Standalone Rivet Pi Mate](../../../docs/decisions/adr-0001-standalone-rivet-pi-mate.md)

## Why this is independent of Mugamaa

- The registry imports nothing from `examples/mugamaa`.
- The runtime does not share `RIVET_ENDPOINT` with the Mugamaa runtime
  by default; the operator runs them on separate Engines or namespaces.
- The Pi Mate actor key uses a fresh `["mate", ...]` tuple, not a
  Mugamaa `["audit" | "works" | "planning", ...]` key.
- Credentials are pulled from environment variables defined by this
  service, not from any Mugamaa credential store.
- The service does not enable Centaur `stateVolume` for Pi durability;
  Pi session persistence comes from the actor's own SQLite.

## Architecture boundary

The Pi Mate service owns the Pi transcript, session tree, compaction,
retries, model selection, actor hibernation, event streaming, and the
selected sandbox provider. The upstream integrator (Centaur, for the
prototype) owns Slack signature verification, ingress policy, prompt
forwarding, event rendering, and delivery metadata. Later Mugamaa
integration is intentionally out of scope and is gated on
`mugamaa-jen.7`.

## License

MIT.
