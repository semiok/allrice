# V1 contract test matrix

| Boundary              | Allow case                                                    | Deny/recovery case                                                                   | Owner              |
| --------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------ |
| Request authorization | owner reads private resource; member reads workspace resource | forged organization/workspace; admin reads another user's private data               | MET-41             |
| Worker authorization  | current PolicySnapshot has exact resource/action grant        | expired snapshot, wrong tenant, absent grant, revoked before new Run                 | MET-41/MET-43      |
| Queue claim           | one Worker atomically claims an available Job                 | competing claim loses; expired lease recovers; live lease cannot be stolen           | MET-43             |
| Queue retry           | retryable failure schedules capped backoff                    | exhausted attempts dead-letter; duplicate idempotency key does not duplicate effect  | MET-43             |
| Cancellation          | queued/running job reaches canceled with evidence             | terminal job cannot transition; irreversible side effect follows compensation policy | MET-43             |
| Run events            | gap-free event sequence reaches one terminal event            | duplicate ID/sequence, gap and suffix after terminal fail                            | MET-43             |
| SSE                   | Last-Event-ID replays later events after reconnect            | invalid, expired and foreign-Run cursors disclose no cross-tenant data               | MET-43/MET-50      |
| Skill artifact        | published immutable artifact checksum matches                 | checksum replacement, revoked version or capability escalation is denied             | MET-44             |
| Skill installation    | User A favorites/enables personal installation                | state does not mutate shared Skill or User B installation                            | MET-44             |
| Storage key           | authorized tenant-scoped opaque key reads                     | traversal, absolute host path, guessed ID/key and cross-tenant signed grant fail     | MET-42             |
| Storage lifecycle     | upload checksum, delete and restore remain consistent         | expired grant, deleted object, quota/type violation fail and audit                   | MET-42             |
| Compatibility         | supported schema/API versions parse during rolling upgrade    | unsupported Job/Event version fails before execution                                 | MET-43/MET-47      |
| OpenRice outage       | last valid bounded policy projection handles low-risk action  | expired policy blocks high-risk action; outage never widens access                   | Future integration |
