# Harness Adapter and Employee Kernel

AllRice treats an AI employee definition and an agent harness as separate
concerns. An employee describes identity, policy, skills, knowledge access and
runtime preference. A harness owns model-session execution.

The execution path is:

```text
Employee run snapshot
  -> Employee Kernel (identity + context + policy + capabilities)
  -> Harness Router
  -> Harness Adapter (Codex today, DSH later)
  -> normalized HarnessEvent stream
  -> durable RunEvent stream
```

This adapter boundary is hosted by
[AllRice ChatFlow Runtime](chatflow-runtime.md), the multi-Harness SaaS
conversation control plane. ChatFlow owns product Session/Run/Event authority;
the adapter preserves each Harness's native session, agent loop and streaming
semantics.

## Boundary

`EmployeeKernelRequest` is provider-neutral. It is assembled from the immutable
employee run snapshot and contains only authorized context. The kernel does not
know Codex RPC methods, thread payloads or CLI flags.

`HarnessAdapter` owns the lifecycle boundary. Its stable contract covers
execution, interruption, steering, compaction and recovery. Each adapter must
publish `HarnessCapabilities`; unsupported operations remain explicitly false
instead of being emulated or silently ignored.

`HarnessEvent` is the only event shape consumed by the employee Worker path. It
includes harness, generation, attempt, local order, thread and turn identity.
Provider-specific events must be normalized before leaving an adapter.

## Current support

The production router registers both `CodexHarnessAdapter` and
`DshHarnessAdapter`.

- Codex wraps the persistent Codex App Server thread and forwards native agent
  message deltas, tool events, usage, steer and compaction lifecycle.
- DSH runs the pinned headless DSH SDK distribution as one restricted JSON-RPC
  runtime per active AllRice conversation and forwards native session/turn,
  assistant chunk and usage events.
- Both adapters execute tenant capabilities only through the AllRice Tool
  Broker and publish the same durable HarnessEvent boundary.
- Unsupported behavior remains explicit in each adapter's capability matrix;
  for example, the pinned DSH protocol does not expose active-turn steer.

## Follow-on convergence

MET-79 converges the working adapter paths behind ChatFlow Runtime without a
big-bang rewrite. The current PostgreSQL RunEvent plus resumable SSE path stays
as the durable/fallback track while a PostgreSQL `LISTEN/NOTIFY` realtime track
is introduced. Redis Streams or NATS is a measured scale-up option, not a V1
prerequisite and never a replacement for durable Session/Run/Event authority.
