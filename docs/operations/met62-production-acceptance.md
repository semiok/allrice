# MET-62 production acceptance

MET-62 is the convergence gate for ChatFlow 2.0, the platform model pool and
the independent SaaS UI. Passing unit tests alone is insufficient: the same
artifact must pass contracts, build, migration, deployed health and reversible
rollout checks.

## Automated gate

```bash
pnpm format:check
pnpm lint
pnpm met62:verify
DATABASE_URL=... pnpm db:verify
ALLRICE_ACCEPTANCE_BASE_URL=https://dev.example.com pnpm met62:verify
DATABASE_URL=... ALLRICE_ACCEPTANCE_BASE_URL=https://dev.example.com pnpm met81:chatflow-smoke
DATABASE_URL=... ALLRICE_ACCEPTANCE_BASE_URL=https://dev.example.com pnpm met83:fallback-smoke
DATABASE_URL=... ALLRICE_ACCEPTANCE_BASE_URL=https://dev.example.com pnpm met86:ui-smoke
```

`met62:verify` validates the pinned DSH distribution, TypeScript boundaries,
Codex authorization parser, model routing, explicit fallback, quota/circuit
preflight, employee capability freezing, ChatFlow recovery contracts and a
production build. When a base URL is supplied it also validates Web liveness,
database readiness and all new ChatFlow UI routes.

## Required manual canary matrix

| Area           | Required evidence                                                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex Provider | DSH `openai-codex` authorization succeeds; a multi-turn Session keeps one native DSH thread and retains context                               |
| API Provider   | DSH API routes stream native deltas/tool events; explicit fallback never changes Harness and remains auditable                                |
| ChatFlow       | canonical events, stop, reconnect and compaction preserve ordering; `Last-Event-ID` never duplicates the final message                        |
| Routing        | only frozen explicit failure conditions permit fallback; fallback is visible and auditable                                                    |
| Tenancy        | two users in two workspaces cannot list, stream, mutate or recover each other's resources                                                     |
| Governance     | quota rejects before execution; circuit opens after threshold; platform kill switch and reset are audited                                     |
| Roles          | member sees assigned employees only; tenant admin sees employee controls; platform admin additionally sees Provider/OAuth/governance controls |
| Recovery       | Web, Worker and browser reconnect recover from PostgreSQL cursor without event loss or duplicate final messages                               |

## Cutover and rollback

1. Keep V1 SSE and legacy workspace enabled while the development canary runs.
2. Enable ChatFlow 2.0 for internal users and compare durable Event IDs against
   the realtime transcript.
3. Set `ALLRICE_LEGACY_WORKSPACE_ENABLED=0` for the canary tenant only after the
   manual matrix passes.
4. Promote the same image to one production tenant.
5. Default to the new UI only after stable observation; preserve the flags and
   previous compatible image for rollback.

Rollback changes the UI/realtime flags or deploys the previous compatible
image. It never rewrites Session snapshots, RouteDecision evidence or the usage
ledger. PostgreSQL remains authoritative throughout.
