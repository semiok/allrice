# Bridge control timing

## Desktop exit during preparation

Runtime preparation and task execution have separate cancellation paths. On
desktop quit, Python Engine JSON/log requests receive the preparation signal;
late replies cannot start another image/probe step or advertise availability.
Once probe creation may have committed, cleanup uses a separate 10s budget:
read back the unique attempt/name and fixed image, confirm stop, delete, and
confirm absence. An unknown create/stop/delete remains `STOP_NOT_CONFIRMED`.

The managed VM's owned start/stop CLI is observed through actual child exit.
Cancellation or its deadline sends TERM, then KILL only to that exact child;
inherited stdout pipes cannot keep the result open indefinitely. Stop uses a
25s child budget followed by a 5s independent query of the dedicated private
Colima profile. A successful/killed CLI is not VM-stop evidence. A running,
malformed or unqueryable profile, or an unconfirmed child exit, retains recovery
state and cannot report safe shutdown. Unrelated processes and profiles are
outside this authority.

Desktop diagnostics expose only fixed component/step identifiers, elapsed
milliseconds and a bounded history. They distinguish downloads, VM startup,
Engine checks, probe logs/cleanup and VM stop verification without exporting
paths, URLs, arguments or credentials. The existing 60s native observation
boundary still offers recovery while cleanup is observed; it does not authorize
abandoning effects or automatic force-exit.

Core preparation coverage lives in `core-preparation-shutdown.test.ts`; real
HTTP and cancellation boundaries in `preflight-cancellation.test.ts`,
`local-docker-cancellation.test.ts` and `project-logs.test.ts`; owned child and VM
confirmation in `managed-stop-deadline.test.ts`. These deterministic fixtures
complement actual packaged-Core/native-menu acceptance on Intel and Apple
silicon. Idle exit or a simulated Core alone cannot establish preparation exit
coverage. Preserve the original failed diagnostic when a later candidate passes.

Finite local commands, Python and project commands use three separate clocks:

- The authority freezes the task/command budget before preparation. The existing 10/30/60 minute policy and progress-based extensions remain unchanged.
- Public device control requests verify current ownership, cancellation, execution identity and network admission. This is an HTTP roundtrip, not a task budget.
- Private PID 1 control keeps a physical process alive only until the last acknowledged execution deadline and a bounded local liveness lease, whichever expires first.

## Evidence and initial envelope

On 2026-10-16, ordinary Dev Run `6d323668-0626-48bc-93f2-5241c46cdcd8` obtained network access and a server-side budget extension but stopped with `lease_lost` before the client recorded that extension. The original unknown operation and external-request evidence were retained; execution was not replayed. The old system combined a 2.5s HTTP timeout, 3s control-cycle timeout, 2s network-authority timeout and 5s physical lease. The backend's cold threat-DNS check alone allows 4s. These limits were inconsistent even before local metrics and public ingress time.

A small diagnostic sample on the actual public Dev path measured 24 fresh-connection health requests at 1.121–2.150s (median 1.286s). Twelve uncached backend admission checks measured 0.962–3.028s (median 1.442s); one returned check-unavailable. Health timings are not authenticated transaction timings. These small samples do not establish p99 or p99.9, and changing a timeout cannot make unavailable risk evidence valid.

The candidate envelope is derived from the existing component bounds:

| Clock                                   | Bound | Derivation                                                                                                   |
| --------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------ |
| Bridge HTTP and network authority check | 8s    | 4s risk lookup + observed 2.15s public path + 1.85s allowance for database/control processing and scheduling |
| One local control cycle                 | 11s   | 8s request + trusted Docker metrics (0.5s inspect, 1.5s stats, 0.5s inspect) + 0.5s margin                   |
| Private finite PID 1 lease              | 20s   | 2.5s attach + 1s periodic scheduling + 1s outer inspections + 11s cycle + 2s control write + 2.5s margin     |

The allowance is a bounded engineering starting point, not a measured production tail percentile. Validate with injected slow responses and native Intel/Apple silicon, then ordinary public tasks. Future tuning should use separate request/check/metrics latency observations and an explicit acceptable false-timeout rate. Do not keep raising timeouts to hide overloaded databases, blocked lookups or unresponsive processes.

## Stop semantics

- Physical leases remain capped by the latest _acknowledged_ execution deadline. A pending server extension is not a local grant.
- A known cancellation/revocation stops immediately when received; silence is bounded by the request/cycle limits and ultimately the 20s physical lease. Closing the private channel terminates PID 1 without waiting for the lease.
- A paused/crashed controller cannot renew its own lease. Late replies cannot reopen a closed controller or network session.
- Network-grant expiry remains an independent bound. Cloud network authority retains its existing 2s timeout; only the trusted Bridge adapter selects 8s.
- No command replay, host networking fallback, TLS bypass, DSH core change or extra user setting is introduced.

## MET-190: lost control acknowledgements

Run `20f5c071-2232-411f-ab1b-4d0ebcf6e4d6` stopped near its first renewal with `lease_lost`, exit 137 and no client-recorded extension. Its server operation lease remained valid. The old receipt did not record the failing control phase, so that individual run cannot retrospectively establish whether HTTP, metrics or the private channel failed. Its unknown external-request outcome remains preserved. A later successful run is not proof that the original failure was fixed.

The reproducible defect is that a fast HTTP disconnection immediately failed a heartbeat or budget exchange. A real HTTP fixture commits a renewal and drops its acknowledgement; the old client abandons execution even though the authority has accepted the request. Bridge now permits one reconnect for a recognized transport failure on only the idempotent heartbeat, budget, network-admission and output-evidence routes. Both attempts share the original request deadline, with the exact same body, renewal ID, sequence, counters or output bytes. No second extension or command execution is allocated.

- HTTP denial (including 5xx), malformed replies, cancellation and an exhausted request deadline are not retried. Start, claim, receipt delivery, tenant commands and external-service requests are outside this helper.
- Control failure evidence distinguishes heartbeat, budget, network admission, output, container inspection, metrics, private connection/write and cycle deadline. It records bounded enums, timestamps, elapsed milliseconds, attempt count and allowlisted HTTP/transport codes. No raw exception, URL, token, response body or stack is persisted in these fields.
- The failure is included in stopped Node/Python result evidence; uncertain outcomes keep a safe phase/kind summary and structured Core logs. A rejected control admission before invoking the runner is settled as failed with no execution. An uncertain running process or external effect stays uncertain.
- The 8s/11s/20s limits and business budgets above do not change. A late reply cannot grant a closed controller another lease or overwrite a proven terminal result.

`control-request.test.ts` exercises real dropped HTTP replies and bounded retries; `bridge-control-recovery-native.ts` exercises Node and managed Python on each native architecture, including one accepted renewal with a lost reply, persistent disconnect and explicit denial. Native execution and public Dev acceptance must be completed before treating this as delivered.

## References

[AWS: Timeouts, retries, and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/) recommends selecting an acceptable false-timeout rate, measuring downstream tail latency and including WAN/connection overhead. It also warns that a timeout does not prove an operation had no side effect.

[gRPC deadlines](https://grpc.io/docs/guides/deadlines/) recommends realistic, load-tested deadlines and subtracting time already spent when propagating the remaining budget.

[Temporal activity failure detection](https://docs.temporal.io/encyclopedia/detecting-activity-failures) separates execution limits from heartbeat failure detection and notes that cancellation delivery can depend on heartbeats. AllRice retains its own no-replay operation semantics.
