# Operations, release and recovery

> Status: **Baseline plus MET-43 Worker recovery implemented**
>
> Linear: **MET-39, MET-47**

## Deployment shape

V1 deploys Web, Worker, PostgreSQL/pgvector, mounted storage and reverse proxy with Docker Compose. There is no desktop package, updater, Apple signing, Rust toolchain, Kubernetes or Redis.

## Health

- liveness proves a process can serve requests;
- readiness proves required dependencies are available;
- version information is included in health responses;
- reverse proxy sends user traffic only to ready Web instances;
- Worker readiness tracks PostgreSQL connectivity.
- Worker startup runs persistent queue maintenance before claims; expired leases are recoverable by any authorized replacement Worker.

## Release sequence

```text
build immutable image
-> backup database and storage
-> apply migrations
-> start Web/Worker
-> readiness/health checks
-> smoke test employee path
-> expose traffic
```

## Backup and restore

Database and object storage are one recovery set. A backup is not accepted until a restore drill verifies ownership, checksums, migration version, signed access and representative Session/Memory/Artifact reads.

## Rollback

Rollback supports the previous compatible image and documented database compatibility window. Destructive migrations require expand/migrate/contract steps rather than assuming an old binary can read a new schema.

## Observability

Logs include service, version, request/run/job IDs and tenant-safe diagnostic context. They exclude Secrets, tokens, private content and host paths. AuditEvent is business evidence, not a substitute for infrastructure logs.

## Current baseline

- Compose and container definitions;
- isolated Linux/Compose smoke coverage in CI;
- Web and Worker health endpoints;
- PostgreSQL readiness;
- migration runner under an advisory lock;
- CI for formatting, lint, types, tests and builds.
- persistent Queue/Run/RunEvent state and a SIGKILL Worker recovery smoke.

Run `pnpm test:compose` to build the production images, start PostgreSQL/pgvector, apply migrations, wait for Web and Worker readiness, verify the migration ledger and vector extension, and tear down the isolated test stack.

## Acceptance

MET-47 requires a real Linux/Compose start, Web/Worker/PostgreSQL restart, migration, backup, restore, health check and rollback drill. Static Compose validation alone is insufficient for release approval.
