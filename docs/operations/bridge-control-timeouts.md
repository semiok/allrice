# Bridge control timing

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

## References

[AWS: Timeouts, retries, and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/) recommends selecting an acceptable false-timeout rate, measuring downstream tail latency and including WAN/connection overhead. It also warns that a timeout does not prove an operation had no side effect.

[gRPC deadlines](https://grpc.io/docs/guides/deadlines/) recommends realistic, load-tested deadlines and subtracting time already spent when propagating the remaining budget.

[Temporal activity failure detection](https://docs.temporal.io/encyclopedia/detecting-activity-failures) separates execution limits from heartbeat failure detection and notes that cancellation delivery can depend on heartbeats. AllRice retains its own no-replay operation semantics.
