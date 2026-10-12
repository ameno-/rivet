# Pi Mate Observability

How the standalone Pi Mate stack is scraped and where its signals surface. The
stack has two independently restartable processes, and both expose Prometheus
metrics:

| Process | Endpoint | Default | Metric families |
| --- | --- | --- | --- |
| Rivet Engine | `RIVET__METRICS__HOST`:`RIVET__METRICS__PORT` | `127.0.0.1:6422` | ~175 (`rivet_*`) |
| Pi Mate runtime | `http://HOST:PORT/metrics` | `127.0.0.1:6423` | ~21 (`rivet_rivetkit_*`, `rivet_tokio_*`) |

The runtime serves `/metrics` from the same HTTP server as `/health` and
`/ready` (`src/metrics.ts`, mounted in `src/runtime.ts` and `src/server.ts`). It
returns `503 {"status":"starting"}` before `registry.startAndWait()` resolves,
so a scrape during boot is distinguishable from a scrape against a serving
runtime. The Engine exposes its own metrics port independently of the guard
port; it is not part of the public API surface.

## Engine metrics environment

The Engine reads its metrics listener from the environment. The live-proof
deployment uses:

```bash
RIVET__METRICS__HOST=127.0.0.1
RIVET__METRICS__PORT=6422
```

Binding to `127.0.0.1` is only scrapeable from the same host. When the Engine
moves to a different machine from Prometheus, bind the metrics listener to the
tailnet address instead and scrape the remote target; do not expose the guard
or API ports to satisfy a scrape.

## Prometheus scrape configuration

Both jobs live in `/home/donatello/services/prometheus/prometheus.yml` on the
observability host:

```yaml
  - job_name: pi_mate_engine
    static_configs:
      - targets: ["127.0.0.1:6422"]
        labels:
          service: "pi-mate-engine"
          stack: "north-star"
          component: "engine"
    metrics_path: /metrics

  - job_name: pi_mate_runtime
    static_configs:
      - targets: ["127.0.0.1:6423"]
        labels:
          service: "pi-mate-runtime"
          stack: "north-star"
          component: "runtime"
    metrics_path: /metrics
```

Reload without a restart:

```bash
curl -X POST http://127.0.0.1:9090/-/reload
```

Prometheus remote-writes to VictoriaMetrics, so both jobs are queryable from
the `Prometheus` and `VictoriaMetrics` Grafana datasources.

### Name collision with the agent-core Engine

The Engine's series are named `rivet_*`, which is the same prefix the
agent-core `rivet-obs-poc` target emits. Always filter by `job`:

```promql
rivet_gasoline_workflow_active{job="pi_mate_engine"}
```

## Dashboard

`north-star-overview.json` on the observability host carries the Pi Mate
panels: Engine and runtime scrape health, Engine workflow population, Engine
API request rate and latency, runtime Tokio and envoy client pressure, and
Slack-agent delivery plus render-recovery obligations. The Slack panels read
the `VictoriaMetrics` datasource because Slack metrics arrive through the
Kubernetes vmagent; the Pi Mate and Ledger panels read `Prometheus`.

The `Ledger appends` and `Ledger validation rejections` panels stay empty until
the Ledger records real research activity: the Ledger only exports a series
once a labelled counter has a sample, so an idle ledger has no series rather
than a zero.

## Boundary

Metrics are counts and durations only. Nothing on these endpoints carries
prompt text, model output, credential material, file paths, or actor keys.
The runtime route is a passthrough of the rivetkit registry metrics; the Mate
does not add counters of its own.

Per-action signals (prompt latency, aborts, thinking level) are **not** exposed
as Prometheus metrics. rivetkit exposes no custom-metric hook to actors in this
version, and the Mate's own event stream is the durable record for those. The
Engine's API request rate and duration panels are the closest action-level
proxy: actor and gateway traffic appears there when the Mate is driven.

## See also

- [`live-proof.md`](./live-proof.md) for the durability phases this stack was
  proven against.
- `mugamaa-7zz` (Beads) / `AME-103` (Linear) for the wiring issue.
