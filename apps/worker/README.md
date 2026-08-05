# Worker application

The Worker is the server-side execution host. Version 0.1.0 provides process health and database readiness; it intentionally does not claim or execute business jobs before MET-49 freezes the Queue and Run contracts.

## V1 responsibilities

- persistent job claim, lease, heartbeat, retry, cancellation, and recovery;
- Scheduler module for due work;
- authorization re-check and immutable PolicySnapshot before execution;
- AI, Skill, Memory, Connector, and Artifact execution hosts;
- tenant-isolated temporary directories, environment, credentials, and outputs;
- persisted RunEvent emission for SSE replay.

## Health endpoints

- `GET /health/live`: the process is serving HTTP.
- `GET /health/ready`: the most recent PostgreSQL readiness check succeeded.

## Important non-goals in 0.1.0

- no in-memory production queue;
- no fire-and-forget business execution;
- no arbitrary shell or unreviewed Skill execution;
- no independent Scheduler deployment.

See [Worker queue](../../docs/features/worker-queue/README.md), [SkillHub](../../docs/features/skillhub/README.md), and [Operations](../../docs/features/operations/README.md).
