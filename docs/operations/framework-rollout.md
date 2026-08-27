# AllRice ChatFlow 3.0 release policy

`/chatflow` is the only conversation product surface. `/workspace` redirects to
it, and no environment flag can restore the old chat UX. Employee Provider
snapshots and DSH generation promotion remain independently versioned.

Release in this order:

1. Contract, sanitizer, replay-projector and tenant-isolation tests.
2. Development deployment with a real Codex subscription Session.
3. Verify Context, Search, Think, Tool and Answer order during streaming and
   after browser refresh.
4. Verify no prompt, credential, raw tool input/output or hidden reasoning is
   present in the ChatFlow event API.
5. Promote the same immutable image to production and observe Run failures,
   reconnects, first-token latency and Provider circuit state.

Rollback deploys the previous compatible Git/container release and never
rewrites Session snapshots, RouteDecision evidence or usage ledgers. Database
migrations must remain backward-safe for that operational rollback window.
