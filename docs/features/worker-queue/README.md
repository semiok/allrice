# Worker and persistent Queue

> Status: **MET-43 persistent execution plane implemented**
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

PostgreSQL is the authority for `allrice_jobs`, `allrice_runs`, frozen
`allrice_policy_snapshots`, and append-only `allrice_run_events`. Web inserts a
Run, Job, policy snapshot, audit record, and `run.created` event in one
transaction. `(organization_id, idempotency_key)` is serialized under a
transaction advisory lock, so simultaneous browser retries return one Run.

Workers claim with `FOR UPDATE SKIP LOCKED`, increment the attempt, and receive
a unique lease token. Only the matching Worker/token can start, heartbeat,
append events, retry, or finish the Job. The Worker-hosted Scheduler promotes
due retries, applies cancellation and timeout, and recovers expired leases.
Exhausted retry/lease attempts reach `dead_letter`; terminal Run state and its
terminal event commit together.

Before a claim becomes `running`, Worker constructs an `ExecutionContext` from
the immutable policy snapshot and calls `authorizeExecution`. A Worker ID alone
grants nothing. MET-44 SkillRuns freeze their exact SkillVersion/provider;
MET-45 EmployeeRuns additionally freeze EmployeeVersion, Assignment, provider,
SkillVersion grants and prompt context.

`allrice.system.echo` remains the safe queue acceptance handler.
`allrice.skill.run` and `allrice.employee.run` execute through the isolated
Codex subscription harness. Employee terminal state and its assistant Message
are committed in the same Queue transaction.

## HTTP API

- `POST /api/v1/runs` creates or idempotently returns a Run.
- `GET /api/v1/runs/:id?workspaceId=...` returns the authorized snapshot.
- `POST /api/v1/runs/:id/cancel?workspaceId=...` requests cancellation.
- `GET /api/v1/runs/:id/events?workspaceId=...` streams persisted RunEvents.

SSE IDs are `<run_uuid>:<sequence>`. `Last-Event-ID` replays only later events;
a cursor for another Run is rejected before streaming. Events remain in
PostgreSQL in V1, so the current earliest retained sequence is zero.

Example submission:

```json
{
  "workspaceId": "00000000-0000-4000-8000-000000000000",
  "idempotencyKey": "employee-task:42",
  "type": "allrice.system.echo",
  "input": { "value": "hello" },
  "priority": 0,
  "maxAttempts": 3,
  "timeoutMs": 300000
}
```

## Isolation and side effects

Each attempt receives an ignored, mode-0700 directory below
`ALLRICE_EXECUTION_ROOT/<organization>/<workspace>/<owner>/<run>/`. Runtime
environment materialization is an explicit allowlist containing IDs and the
attempt only; database/storage secrets are not passed to handlers. Attempt
directories are deleted after completion. Future Skill/AI handlers must use
the frozen policy context, scoped storage ports, cooperative cancellation, and
provider idempotency keys for every irreversible external effect.

## Acceptance

Unit/contract tests cover transition legality, maintenance ordering, retry
backoff, terminal event rules, cursor replay, and path/environment isolation.
`pnpm test:compose` additionally covers simultaneous duplicate submit,
heartbeat, retry, cancellation, timeout, SSE replay/foreign cursor rejection,
SIGKILL Worker lease recovery, and PostgreSQL/Web restart on a fresh schema.
