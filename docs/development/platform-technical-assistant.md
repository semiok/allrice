# Platform technical assistant — MET167 PR1a

The management console has a technical assistant under Platform settings. It reads existing Web/Worker readiness, release SHA, trusted Worker resource samples, durable queue/resource waiting, database lock waiting, Run/operation states and employee feedback references. Each collection carries its source, environment, time window and freshness. A failed collection is unknown; no missing counter is displayed as measured zero. Run, operation and feedback lists are limited to the most recent 20 records in 24 hours. A full ID can refer to an older record.

The Web readiness target uses its configured `WEB_PORT`. The Worker readiness target must be configured as `ALLRICE_TECHNICAL_WORKER_HEALTH_URL` at the actual co-located loopback Worker port, ending in `/health/ready`. It is deployment configuration, not a browser-supplied URL. Invalid, absent or failed probes preserve unknown state. These probes do not support a remote Worker deployment yet. `/health/ready` includes `x-allrice-release-sha` when the configured release SHA is valid.

Platform authority is the active database user plus the server-owned platform allowlist. The dedicated admin portal authenticates existing sessions against the hidden `allrice-platform/control-plane` scope. It does not require or create company membership, and it does not use company selector headers. Ordinary employee and company-admin identities cannot use these endpoints. An admin session is rejected on the employee portal. Hidden scope initialization continues to use the existing trusted bootstrap mechanism.

A problem stores structured source references, its environment, status/category/severity, evidence count and immutable status events. Repeating a capture returns the canonical stored problem without incrementing its count. Each different source counts once. An administrator can group a new source under an existing problem explicitly; no model guesses causality. An already linked source retains its canonical problem. Updates use an expected version; a conflict returns the actual latest record. An ambiguous browser write must be read back before retrying.

The collector and problem records exclude conversation bodies, scripts, SQL text, credential values and raw provider errors. Existing business records remain authoritative and are not rewritten by diagnostics. Problem data lives in separate platform tables. Refreshing diagnostics does not create a problem or invoke a model.

Routes:

- `GET /api/v1/admin/technical-assistant`: bounded current facts and latest 100 problems.
- `POST /api/v1/admin/technical-assistant`: `{kind, id, issueId?}` for an existing Run, operation or feedback reference.
- `GET /api/v1/admin/technical-assistant/issues/:id`: stored problem with its latest 100 evidence references.
- `PATCH /api/v1/admin/technical-assistant/issues/:id`: `{ifVersion, status, category, severity}`.

All routes require platform authority. Writes additionally require a same-origin browser request. Responses are private/no-store. Admin-only wire schemas are exposed through the pure browser-safe `@allrice/database/technical-contracts` subpath; they do not change the Bridge contracts or require a new native package.

This slice establishes deterministic diagnosis, problem persistence and the actual management UI. Native DSH diagnostic-tool registration and the existing operation ledger follow in PR1b. It does not implement scheduled quality checks, repair agents, GitHub publishing, deployment control or autonomous recovery.

Verification uses the existing PostgreSQL fixture and Vitest. The technical integration suite covers normal/queued/absent/stale/failed-source facts, failure/feedback references, content exclusion, concurrent canonical capture/grouping, version conflicts and revoked authority. The existing unified-login HTTP suite additionally covers an administrator with zero memberships through password login, signed portal session and the technical API. Dev acceptance must exercise actual page clicks, refresh, issue detail/update and denied ordinary-account access.
