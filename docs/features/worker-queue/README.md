# Worker and persistent Queue

> Status: **Worker baseline and MET-49 contracts implemented; persistence pending MET-43**
>
> Linear: **MET-43, MET-49**

## User outcome

Employees can close the browser while long AI/Skill work continues, then return to replay progress and obtain results without duplicate irreversible actions.

## V1 topology

One Worker application process hosts an internal Scheduler module. PostgreSQL stores Job, Run and RunEvent state. There is no production in-memory queue and no Redis dependency.

## Queue contract requirements

- explicit Job states and legal transitions;
- transactional claim;
- lease and heartbeat with expiration;
- stable idempotency key and attempt count;
- retry/backoff and dead-letter state;
- cancellation and timeout;
- crash recovery and orphan detection;
- payload schema version and compatibility window.

## Run/Event requirements

Run freezes actor, organization/workspace, EmployeeVersion, SkillVersion and PolicySnapshot. RunEvent has a stable monotonic ID suitable for SSE `Last-Event-ID`, reconnect and replay.

## Security

Worker re-authorizes before execution and never trusts browser roles. Tenant-specific temporary directories, environment, credentials, Memory and Artifact paths are isolated. High-risk side effects require approval/idempotency policy.

## Current implementation

Version 0.1.0 starts the Worker HTTP process, polls PostgreSQL readiness and exposes liveness/readiness endpoints. MET-49 now defines Job/lease transitions, retry backoff, ExecutionContext, RunEvent ordering and SSE replay without prematurely implementing the MET-43 queue tables.

## Acceptance

Tests will cover competing claims, expired lease, heartbeat, duplicate submit, retry, cancellation, timeout, crash, replay, Web restart, Worker restart and PostgreSQL restart.
