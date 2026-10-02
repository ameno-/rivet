# Pi and Rivet roadmap

## Tracking model

GitHub issues in the `Pi Durable Runtime v0` milestone are the work queue.
Every loop has a concrete exit condition. Do not advance a loop based only on
source review or a passing unit test when it requires a live actor receipt.

## Loop 0: baseline and reproducibility

**Goal:** A fresh agent-core checkout builds the local N-API binding and passes
the focused Pi integration typecheck and test suite.

**Exit evidence:** Commands in `START_HERE.md` pass without modifying tracked
source files other than an intentional, reviewed lockfile update.

## Loop 1: durable storage contract

**Goal:** Specify and test how Pi Durable records map to actor SQLite while
preserving the Rivet Actor single-writer invariant.

**Deliverables:** Storage schema, transaction boundaries, migration plan,
conformance fixture, and storage query-efficiency coverage.

**Exit evidence:** Pi Durable storage conformance runs against the adapter and
an actor restart can reacquire the same committed conversation state.

## Loop 2: resumable execution and tool safety

**Goal:** Recover a pending durable submission after a process interruption
without duplicate side effects.

**Deliverables:** Submission actions, event bridge, task lifecycle mapping,
tool replay classification, and interruption tests.

**Exit evidence:** A safe read-only tool replays only when both stored and
current policy allow it. A sandbox mutation reports an interrupted result
instead of being silently replayed.

## Loop 3: migration and compatibility

**Goal:** Add durable mode without changing default `@rivet-dev/pi` behavior.

**Deliverables:** Explicit opt-in configuration, import strategy, rollback
procedure, compatibility tests, and operator documentation.

**Exit evidence:** Existing Pi actors pass their current tests unchanged, and a
durable-mode actor has a separate inspectable recovery receipt.

## Operating cadence

- Before each implementation session, choose one open issue and restate its
  exit evidence in the change description.
- After each session, attach commands run, test result, and any live actor
  receipt to that issue.
- When a loop exposes a new product decision, open a bounded decision issue
  rather than hiding it in implementation notes.
- Do not mark a loop complete until its exit evidence is repeatable from a
  clean checkout or a disposable actor.
