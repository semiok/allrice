# DSH administrator console

MET-87 deploys the pinned DeepSeek Harness WebUI as a platform engineering
surface. The upstream UI is retained, with one narrow and replayable client
compatibility patch for the authenticated administrator domain. It is not an
AllRice tenant interface and it is not an independent source of production
authorization.

## Network boundary

`@deepseek-ai/dsh web` listens on `127.0.0.1:3080`. The standalone DSH Lab
administrator gateway listens on `3081`, verifies a host-only signed browser
session and proxies HTTP and WebSocket traffic to the loopback WebHost. Caddy
routes only the approved `dsh.*` hosts to that gateway. The DSH WebHost
is never directly exposed to a LAN, tunnel or public reverse proxy.

After host validation and session authentication, the gateway injects an
`allrice-dsh-admin` marker into the HTML shell. A pnpm patch to the pinned
`@deepseek-ai/dsh-client-connection` release recognizes that marker as a
trusted administrator surface, which enables DSH's native settings mirror in
the remote browser. The marker is only a UI capability hint: the gateway
session, host allowlist and loopback-only upstream remain the actual security
boundary. Unauthenticated pages never receive the marker and cannot reach a
privileged RPC.

The patch is committed under `patches/` and declared in
`pnpm-workspace.yaml`. A DSH upgrade must review and reapply it explicitly; a
failed patch is a release blocker rather than permission to bypass the
gateway.

The temporary bootstrap password and both session signing keys live only in
deployment environment variables. Unknown hosts fail with HTTP 421. The DSH
Lab, AllRice Runtime Console and Snow cookies are host-only and cannot select
another portal or tenant.

## Authority boundary

The DSH console owns an isolated administrator Harness home. Platform
engineers may use the official DSH interface to inspect and configure
Providers, models, plugins, presets and native sessions. The authenticated
gateway translates accepted requests into DSH's loopback-same-origin boundary;
without the gateway session, privileged Host APIs are unreachable.

The console shares only the platform DSH credential document with the Worker
authorization broker. This lets the official Models page manage the Codex
subscription grant and platform API keys without copying secrets into AllRice
UI state. Tenant runtime homes, workspaces and Sessions remain isolated, and
the console cannot mutate a frozen EmployeeRun.

Promotion follows this path:

```text
official DSH WebUI -> isolated administrator DSH instance
                   -> reviewed, immutable configuration bundle
                   -> AllRice Plugin / Skill Registry
                   -> ChatFlow employee and tenant policy intersection
                   -> frozen runtime profile for a new Session
```

The publish bridge is the only future mutation seam between the administrator
Harness and production. Direct copying of the administrator DSH home into a
Worker is prohibited.

## Runtime difference view

The official settings dialog includes an AllRice-owned
`版本与能力` section. It is registered through DSH's native
`settings.section` slot, so it follows the upstream dialog layout, theme and
scroll behavior instead of maintaining a second settings shell.

The section records three explicit sets:

- capabilities shared by the administrator instance and Worker runtime;
- capabilities available only in the full administrator Web profile;
- capabilities supplied only by AllRice, such as ChatFlow, Tool Broker,
  Employee capability assembly and Rice Bridge.

Both administrator surfaces share the version-reviewed descriptions in
`packages/dsh-runtime-diff/capabilities.json`. The Lab gateway reads its own
installed DSH package version into authenticated HTML. AllRice's header labels
its build version; the capability page reads live Worker versions and facts
from the administrator-only, uncached `/api/v1/admin/runtime-console/capabilities`.
The descriptions distinguish integrated features, upstream reuse candidates
and alpha-only previews; mismatched Worker versions mark the review as stale.

Workers report every five seconds into `allrice_runtime_metadata`, under a
worker-specific `dsh-worker-capabilities:` key. Reports contain installed
package versions, the actual Cordis composition digest and entry states, and
the existing tool-availability checks evaluated in the Worker process. No
config values, credentials or filesystem paths are published. Upstream's YAML
parser preserves `!!js` expressions without evaluating them. Unsupported
custom executables or unreadable profiles report unknown; disabled, conditional
and missing entries are excluded from the configured count. These facts describe
the composition for new tasks, not currently loaded idle processes.

The API expires heartbeats after 20 seconds using database time, preserves
separate Worker reports, and reads actual tenant versions assigned to active
members rather than platform drafts. It returns published Skill IDs and tools
alongside the current enabled/reviewed Skill catalog. The page refreshes every
10 seconds, shows per-Worker count ranges for mixed deployments, and reports
unknown on failed reads instead of substituting static counts or zeroes.
Integrated capability cards check both Worker and Web tool switches and tenant
publication/execute-policy state; task-time member, action and device checks
still apply. An installed package or a published Skill alone is not a claim
that every tenant can execute every tool.

Integrated optional capabilities link to the existing employee configuration,
trial and tenant publication flow. Native experiments remain in the Lab;
execution and file changes continue through their existing approval paths.

## Live Lab state and AllRice sync

The Lab's native `版本与能力` section now polls its authenticated same-origin
`/api/allrice/capabilities` endpoint every ten seconds. Its two panels remain
independent:

- **DSH 实际运行状态** comes from the running native loader, sent over private
  parent/child IPC every five seconds. It lists each non-group plugin and its
  active, disabled, pending, failed or unknown state. Counts therefore describe
  actual loaded plugins, unlike the Worker's installed configuration count.
  The gateway timestamps receipt, expires reports after twenty seconds, and
  reports an unknown version for a custom executable. No configs, errors,
  credentials or local module paths cross this telemetry boundary.
- **AllRice 实际接入状态** comes from the same inventory and projection used by
  the AllRice console: online Workers, engine/build versions, configured
  components, enhancements, available/published Skills and tenant employee
  versions. Integrated capability badges use actual Worker/Web gates and
  tenant publication/execute policies. Unavailable data is shown as unknown;
  failure on one side does not hide successful facts on the other.

Configure a random `ALLRICE_CAPABILITY_SYNC_TOKEN` (at least 32 characters) in
both **Web and the Lab gateway**, and set the gateway's
`ALLRICE_CAPABILITY_SYNC_BASE_URL` to the corresponding Web origin (Compose:
`http://web:3000`; local Dev Web: `http://127.0.0.1:3001`). Use the private
service network or HTTPS between hosts. The fixed read-only
`/api/v1/internal/runtime-capabilities` endpoint accepts only this token and
exports aggregate facts, never tenant names/IDs or employee manifests. The
exact route bypasses portal cookies but validates its token before any reads;
other APIs retain their existing authentication. The token is removed from
the native DSH subprocess environment and never returned to the browser.
Redirects, responses over 64 KiB, invalid schemas and snapshots older than
30 seconds fail to unknown. Requests time out after four seconds.

`@allrice/dsh-admin` now consumes the built contracts package. Build contracts
before starting the gateway locally (`pnpm --filter @allrice/contracts build`);
the Docker image and root test command do this automatically. Shared capability
descriptions and architecture comparisons remain documentation, not evidence
that a plugin is currently running or a tenant may execute it.

## Temporary portals

| Host family      | Surface                 | Current authority                                          |
| ---------------- | ----------------------- | ---------------------------------------------------------- |
| `dsh.*`          | Official DSH WebUI      | Isolated DSH Lab administrator                             |
| `allrice-dsh.*`  | AllRice Runtime Console | Runtime facts, employee production and platform governance |
| `allrice-snow.*` | AllRice workspace       | Snow member principal                                      |

The bootstrap adapter is replaceable. A future SSO/RBAC implementation must
continue producing the same trusted server-side portal, actor, organization
and workspace context; browser-supplied role or tenant identifiers remain
untrusted.

## Runtime Console boundary

MET-90 separates the standalone Lab from the SaaS runtime surface. The Lab at
`dsh.*` remains a fully isolated DSH Web profile. The Runtime Console at
`allrice-dsh.*` reads the durable ChatFlow runtime registry and, in later
phases, the Worker's native-event gateway. It must not start a second DSH Home
or attach a second client directly to a tenant JSON-RPC process.

Runtime inventory remains read-only: it shows tenant-safe organization,
workspace, Session, Worker lease, Thread generation, frozen Provider/model
identity, context pressure and lifecycle state. MET-93 adds a separate
platform-authorized employee production module backed by AllRice PostgreSQL;
it does not make tenant runtimes or DSH Homes mutable. Prompts, credentials,
host paths, raw tool arguments and hidden reasoning are never part of the
runtime inventory API.

Provider authorization, model release, circuit breaking, quota and usage
governance are also first-class Runtime Console modules. AllRice does not
operate a separate `allrice-admin.*` website or retain the historical
`/chatflow/admin` compatibility route.
