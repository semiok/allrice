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
deployment environment variables. Unknown hosts fail with HTTP 421. The DSH,
platform-admin, Snow and Drink cookies are host-only and cannot select another
portal or tenant.

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

The official settings dialog includes an AllRice-owned, read-only
`Runtime 差异` section. It is registered through DSH's native
`settings.section` slot, so it follows the upstream dialog layout, theme and
scroll behavior instead of maintaining a second settings shell.

The section records three explicit sets:

- capabilities shared by the administrator instance and Worker runtime;
- capabilities available only in the full administrator Web profile;
- capabilities supplied only by AllRice, such as ChatFlow, Tool Broker,
  Employee capability assembly and Rice Bridge.

This first version is a reviewed architecture snapshot, not a live publish
button. It deliberately cannot enable a plugin or mutate a Worker. A future
sync bridge can replace the snapshot with inventory data and drift status,
but promotion must still follow the review and immutable-bundle path above.

## Temporary portals

| Host family       | Surface                 | Current authority                |
| ----------------- | ----------------------- | -------------------------------- |
| `dsh.*`           | Official DSH WebUI      | Isolated DSH Lab administrator   |
| `allrice-dsh.*`   | AllRice Runtime Console | ChatFlow read-only runtime facts |
| `allrice-admin.*` | AllRice control plane   | One platform administrator       |
| `allrice-snow.*`  | AllRice workspace       | Snow member principal            |
| `allrice-drink.*` | AllRice workspace       | Drink member principal           |

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

The first phase is deliberately read-only: it shows tenant-safe organization,
workspace, Session, Worker lease, Thread generation, frozen Provider/model
identity, context pressure and lifecycle state. Prompts, credentials, host
paths, raw tool arguments and hidden reasoning are never part of this API.
