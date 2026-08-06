# Worker application

The Worker is the server-side execution host. MET-43 implements the persistent
PostgreSQL Queue, Worker-hosted Scheduler, lease recovery, frozen policy
authorization and RunEvent persistence defined by MET-49. MET-44 adds the
version-pinned Codex SkillRun handler. MET-45 adds the Rice EmployeeRun
harness over the same execution boundary.

## V1 responsibilities

- persistent job claim, lease, heartbeat, retry, cancellation, and recovery;
- Scheduler module for due work;
- authorization re-check and immutable PolicySnapshot before execution;
- the audited Codex subscription Skill execution host;
- persistent per-Session Codex threads on a shared long-lived app-server;
- PostgreSQL run/turn/Worker ownership and restart-safe thread resume;
- tenant-isolated temporary directories, environment, credentials, and outputs;
- persisted RunEvent emission for SSE replay.

## Health endpoints

- `GET /health/live`: the process is serving HTTP.
- `GET /health/ready`: PostgreSQL and the persistent queue are ready. Codex
  subscription connectivity is reported separately through
  `GET /api/v1/admin/providers/codex`; a disconnected provider must not prevent
  the core application or bootstrap smoke from starting.

## Runtime configuration

| Variable                          | Default               | Purpose                                       |
| --------------------------------- | --------------------- | --------------------------------------------- |
| `ALLRICE_WORKER_ID`               | process UUID          | Stable deployment identity when supplied      |
| `ALLRICE_WORKER_POLL_INTERVAL_MS` | `1000`                | Scheduler/claim cadence                       |
| `ALLRICE_WORKER_LEASE_MS`         | `30000`               | Claim lease duration                          |
| `ALLRICE_WORKER_HEARTBEAT_MS`     | about one-third lease | Lease heartbeat cadence                       |
| `ALLRICE_WORKER_CONCURRENCY`      | `1`                   | Maximum in-process executions                 |
| `ALLRICE_EXECUTION_ROOT`          | `.local/executions`   | Tenant/run/attempt scratch root               |
| `ALLRICE_STORAGE_ROOT`            | `.local/storage`      | Immutable Skill artifact storage              |
| `ALLRICE_CODEX_COMMAND`           | `codex`               | Pinned Codex CLI executable                   |
| `ALLRICE_CODEX_AUTH_HOME`         | current `~/.codex`    | Deployment credential directory               |
| `ALLRICE_CODEX_MODEL`             | `gpt-5.6-luna`        | Model frozen into new Skill/Employee runs     |
| `ALLRICE_CODEX_REASONING_EFFORT`  | `high`                | Reasoning frozen into new Skill/Employee runs |

`ALLRICE_WORKER_HEARTBEAT_MS` must be lower than the lease. Production
deployments should provide a stable, unique UUID per Worker replica.

## Current non-goals

- no in-memory production queue;
- no fire-and-forget business execution;
- no arbitrary shell, Connector, multi-provider or unreviewed Skill execution;
- no independent Scheduler deployment.

See [Worker queue](../../docs/features/worker-queue/README.md), [SkillHub](../../docs/features/skillhub/README.md), and [Operations](../../docs/features/operations/README.md).
