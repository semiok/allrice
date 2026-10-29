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

| Variable                                           | Default               | Purpose                                                 |
| -------------------------------------------------- | --------------------- | ------------------------------------------------------- |
| `ALLRICE_WORKER_ID`                                | process UUID          | Stable deployment identity when supplied                |
| `ALLRICE_WORKER_POLL_INTERVAL_MS`                  | `1000`                | Scheduler/claim cadence                                 |
| `ALLRICE_WORKER_QUEUE_WAKEUP`                      | `1`                   | `0` turns off LISTEN/NOTIFY claim wakeups (MET-223)     |
| `ALLRICE_WORKER_QUEUE_WAKEUP_PROBE_MS`             | `30000`               | Wakeup connection liveness probe cadence                |
| `ALLRICE_WORKER_QUEUE_WAKEUP_TIMEOUT_MS`           | `10000`               | Wakeup LISTEN setup and probe round-trip limit          |
| `ALLRICE_WORKER_LEASE_MS`                          | `30000`               | Claim lease duration                                    |
| `ALLRICE_WORKER_HEARTBEAT_MS`                      | about one-third lease | Lease heartbeat cadence                                 |
| `ALLRICE_WORKER_CONCURRENCY`                       | `auto`                | Maximum in-process executions (`auto` or 1..32)         |
| `ALLRICE_WORKER_MIN_AVAILABLE_MEMORY_MB`           | `256`                 | Pause claims below this available memory; `0` disables  |
| `ALLRICE_WORKER_MEMORY_PAUSE_PRESSURE`             | `critical`            | Pause at macOS pressure `warn`/`critical`; or `off`     |
| `ALLRICE_EXECUTION_ROOT`                           | `.local/executions`   | Tenant/run/attempt scratch root                         |
| `ALLRICE_STORAGE_ROOT`                             | `.local/storage`      | Immutable Skill artifact storage                        |
| `ALLRICE_DSH_CODEX_MODEL`                          | `gpt-5.6-luna`        | Model used by DSH's Codex subscription Provider         |
| `ALLRICE_DSH_CODEX_REASONING_EFFORT`               | `xhigh`               | Reasoning used by the DSH Codex Provider                |
| `ALLRICE_DSH_PLATFORM_HOME`                        | `.local/dsh-platform` | Private DSH Provider credential/configuration directory |
| `ALLRICE_DSH_HTTP_PROXY`                           | unset                 | Explicit HTTP egress proxy inherited by DSH children    |
| `ALLRICE_DSH_HTTPS_PROXY`                          | unset                 | Explicit HTTPS egress proxy inherited by DSH children   |
| `ALLRICE_DSH_NO_PROXY`                             | unset                 | Optional DSH child proxy bypass list                    |
| `ALLRICE_DSH_IDLE_CLOSE_MINUTES`                   | `30`                  | Close a conversation's idle DSH process; `0` disables   |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`              | auto-detected         | Managed-browser Chromium executable                     |
| `ALLRICE_MANAGED_BROWSER_DISABLE_CHROMIUM_SANDBOX` | unset                 | Local development escape hatch; production refuses `1`  |

The claim gate (MET-219) checks memory before each claim. On macOS it reads,
without privilege, the kernel pressure level and the pages jetsam counts as
available (free, pageable file-backed and purgeable), at most every two
seconds; elsewhere it reads libuv's `availableMemory()` (MemAvailable or the
cgroup headroom) every time. Claims pause below
`ALLRICE_WORKER_MIN_AVAILABLE_MEMORY_MB` or at
`ALLRICE_WORKER_MEMORY_PAUSE_PRESSURE`. At `warn` pressure below that level,
background work waits and foreground work fills at most half the slots; `off`
ignores the pressure level but keeps the floor. Automatic concurrency uses the
same estimate. Changes are logged as `[MET-219] memory gate …`, at most once a
minute.

The Worker does not invoke Codex CLI. DSH is the only Harness; the Codex
subscription is authorized and executed as DSH's `openai-codex` Provider.

`ALLRICE_CLOUD_COMMAND_TIMEOUT_MS` (default `30000`, range `500..60000`) and
`ALLRICE_CLOUD_COMMAND_OUTPUT_BYTES` (default `32768`, range `1024..65536`)
set deployment defaults for new `cloud.process.execute` calls (inline or frozen
scripts) and the cloud branch of `python.execute`. Supply integers in the shared
Web/Worker environment and restart both; invalid values stop startup with the
variable name and allowed range. Explicit call fields override only that field.
The operation freezes effective limits before approval; retries, approvals and
Worker recovery keep those values after configuration changes. Output counts raw
UTF-8 bytes across stdout and stderr together; exceeding the limit still stops
the process. Local Python, Office/project controllers, other resource limits,
long-execution budgets and the DSH outer tool timeout remain unchanged. These are
deployment settings, with no tenant override or management UI in this batch.

`ALLRICE_DSH_IDLE_CLOSE_MINUTES` must be `0` or a decimal number of minutes,
at least `1`; any other value stops the Worker at startup. A process is never
closed during a turn, and the next turn of a closed conversation recovers its
persisted native session on a fresh process.

Program questions (application connection and progress pause) use the Run's
frozen owner preference and DSH `askTimed`, counted from display and capped by
the same idle-close interval; `0` keeps them blocking. A pending progress pause
completes the Run with `waitingForUser` and transfers to the next Run in that
session. Runs using the frozen legacy assistant path retain blocking questions
and do not transfer pauses; remove this exception with subagent PR4a/b/c.

DSH child processes receive no ambient host proxy configuration. Deployments
that require an egress proxy must set the `ALLRICE_DSH_*_PROXY` variables
explicitly; production should use deployment-owned egress rather than a desktop
proxy.

Managed-browser Chromium runs with its process sandbox enabled by default. Each
task receives an authenticated loopback proxy that pins validated public DNS
answers and opens the real socket by numeric IP while preserving the original
HTTP Host and HTTPS SNI. Production startup refuses the development-only
no-sandbox escape hatch.

`ALLRICE_WORKER_HEARTBEAT_MS` must be lower than the lease. Production
deployments should provide a stable, unique UUID per Worker replica.

## Current non-goals

- no in-memory production queue;
- no fire-and-forget business execution;
- no arbitrary shell, Connector, multi-provider or unreviewed Skill execution;
- no independent Scheduler deployment.

See [Worker queue](../../docs/features/worker-queue/README.md), [Agent capability foundation](../../docs/architecture/agent-capability-foundation.md), and [Operations](../../docs/features/operations/README.md).
