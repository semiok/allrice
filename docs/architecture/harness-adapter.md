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

The production router registers `CodexHarnessAdapter`. It wraps the existing
persistent Codex app-server runtime, preserves one active turn per conversation,
and exposes the current capability matrix:

- persistent threads, tool events, usage events, interrupt and recovery: yes;
- assistant delta forwarding, active-turn steer and explicit compact: not yet.

DSH is a planned adapter and is deliberately not registered until it passes the
same adapter conformance and tenant-isolation checks.

## Follow-on phases

- MET-64 enables durable assistant delta streaming through this event boundary.
- MET-65 implements provider-neutral checkpoints and compaction/recovery.
- MET-66 adds steer and a durable follow-up queue with explicit ownership.
