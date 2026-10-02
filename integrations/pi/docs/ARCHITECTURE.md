# Pi and Rivet architecture

## Purpose

`@rivet-dev/pi` runs one Pi coding-agent session inside one Rivet Actor. This
is the supported starting point for the product work. It preserves the
integration's existing `AgentSession` actions and event stream while we learn
from real actor lifecycles.

## Current execution path

```text
Client
  -> RivetKit action dispatch
    -> one Rivet Actor, the single writer
      -> @rivet-dev/pi action facade
        -> Pi AgentSession
          -> model runtime and application credential source
          -> optional sandbox mounting for file and shell tools
      -> actor SQLite for header, entries, settings, and sandbox identity
  <- Pi events through the actor's event event
```

The actor owns one live session per actor generation. Session entries are
serialized to actor SQLite in append order. A stored sandbox identity is reused
after an actor sleeps when its provider still has that sandbox.

## Safety boundary

- Pi resource discovery is isolated by default. Extensions, skills, prompt
  templates, context files, and themes require explicit host configuration.
- Built-in file and shell tools require a sandbox provider. Without one, only
  caller-provided custom tools are available.
- The application supplies credentials. The actor does not read Pi login files.
- The current integration aborts an active run on sleep or destroy and flushes
  history and settings. It persists a session transcript, not in-flight work.

## Durable mode is additive

`@earendil-works/pi-durable` has a different contract: atomic storage commits
for conversations, documents, and tasks, plus replay-aware recovery. It must
not replace `AgentSession` behind the existing `prompt(): Promise<void>` API.

Durable mode will be introduced as a separate, opt-in actor surface with:

1. A Rivet Actor SQLite implementation of Pi Durable's `Storage` contract.
2. Submission- and event-oriented actions that expose durable identifiers.
3. Explicit replay policies for every tool. Sandbox mutation tools are unsafe
   unless a specific idempotency proof says otherwise.
4. An import and rollback path that does not invalidate existing Pi actors.

## Architecture invariants

1. A Rivet Actor remains the only writer for its SQLite state.
2. No task is shown to a client before its durable state is committed.
3. A process restart must not silently replay a potentially mutating tool.
4. Existing `@rivet-dev/pi` behavior remains compatible until durable mode is
   independently proven and explicitly selected.
