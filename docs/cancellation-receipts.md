# Cancellation and receipt closure

A cancellation request stops new admission immediately. It does not prove that
native execution stopped or that model usage is complete. Those are separate
receipts with their original identities. Never repair missing receipts by
writing zero usage, a fabricated native ACK, or a successful Run state.

## Queue contract

- A running Job keeps only its original live Worker/token during a fixed 30s
  receipt window. The first `drain_reason` and `drain_deadline_at` do not slide
  when heartbeat, maintenance, authority polling, cancellation or task clocks
  run again. Maintenance cannot renew an expired incarnation.
- Heartbeat signals abort while keeping this bounded receipt channel. Authority
  polling that observes the deadline first commits the same cutoff. Pending
  calls may finish/settle; new model/tool admission remains closed.
- The adapter shares one bounded stop budget across cancellation, native drain,
  usage reads and flush. It reserves time for the existing owned-host shutdown;
  a child-only successful drain does not close its healthy parent later.
- After the handler returns, the Worker joins one pending heartbeat, flushes
  events and cleans local isolation before finalizing. A stuck heartbeat cannot
  block local cleanup indefinitely or authorize a concurrent finalization.
  Expiry or lost/replaced leases leave terminalization to maintenance. Leased
  queue SQL uses transaction-local 5s lock / 10s statement limits; model/tool
  execution and human waits are outside those control transactions.
- Cancellation remains canceled; a fixed timeout remains failed/JOB_TIMEOUT,
  including a later completion/failure/cancel request. Terminal event writes
  serialize. Queued/claimed Jobs that never executed have no artificial drain.
- Root creation's existing advisory mutex (namespace 703) precedes queue
  root/clock/job locks, including before the root exists. The nonblocking access
  revocation path preserves its existing `55P03` retry behavior.

The window is a receipt cutoff, not extra execution time, an authorization
extension, a release ACK, or a new public Job state. Physical shutdown does not
make unknown token usage known. Global Worker shutdown retains the existing
lease-recovery behavior.

## Core regression commands

Use a disposable integration database accepted by the existing fixture guards;
never point `ALLRICE_TEST_DATABASE_URL` at Dev/Prod or supply an ambient business
`DATABASE_URL`. Every suite owns random schemas and removes them afterwards.

```sh
ALLRICE_RUN_DB_INTEGRATION=1 \
ALLRICE_TEST_DATABASE_URL=postgres://allrice:allrice@127.0.0.1:54329/allrice \
pnpm exec vitest run --maxWorkers=1 \
  packages/database/src/queue-cancellation.integration.test.ts \
  packages/database/src/task-progress.integration.test.ts \
  packages/database/src/task-clock.integration.test.ts \
  packages/database/src/assistant-current-authority.integration.test.ts \
  packages/database/src/assistant-failure-usage.integration.test.ts \
  apps/worker/test/p25/assistant-native.integration.test.ts

pnpm exec vitest run --maxWorkers=2 \
  apps/worker/src/job-runner.test.ts \
  apps/worker/src/harness/dsh/receipt-drain.test.ts \
  apps/worker/src/harness/dsh/assistant-diagnostics-adapter.test.ts
```

| Boundary                                                                                      | Evidence source                                               |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Late model/tool finish; duplicate/conflict; no new progress decision                          | task-progress real PostgreSQL suite                           |
| Heartbeat, maintenance, authority-first timeout; fixed deadline; replaced/expired lease       | queue-cancellation real PostgreSQL suite                      |
| Cancellation/completion/failure races, root first creation, queued/claimed cancellation       | queue-cancellation real PostgreSQL suite                      |
| Actual child-first native ACK; child-only stop; actual owned-process crash without a fake ACK | assistant-native real DSH + loopback model + PostgreSQL suite |
| Generation/fence/tenant/current permissions and post-lock expiry                              | assistant-current-authority suite                             |
| Known/unknown usage and preserved reservations                                                | assistant-failure-usage suite                                 |
| Nonresponsive RPC, one deadline, bounded heartbeat join, Worker shutdown                      | deterministic adapter/Worker unit seams                       |

Native tests use the pinned actual DSH packages and a synthetic local HTTP model;
they incur no paid model calls. Unit seams do not replace native/SQL evidence.
These suites are registered in the existing CI; a kernel upgrade must rerun
the affected current/candidate cases, with the version and package identity
recorded. Dev delivery additionally validates its actual production package,
service identities and owned-resource cleanup. These tests do not constitute
a whole Xiaobai business task or a complete role benchmark.
