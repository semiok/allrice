# Platform-managed model pool

> Implementation: MET-82, MET-81, MET-83 and MET-84.

AllRice is a SaaS control plane, so ordinary tenants do not configure raw model
credentials. A platform administrator publishes managed Provider connections;
a tenant administrator selects one of those approved models for each AI
employee; a Session freezes that selection before its first Run.

```text
Platform administrator
  -> Provider + managed connection + credential reference
       -> model catalog
            -> tenant administrator employee policy
                 -> immutable SessionModelSnapshot
                      -> Harness Router -> Codex or DSH
```

The default platform selection is:

- Harness: Codex Harness;
- authentication: platform ChatGPT subscription;
- model: `gpt-5.6-luna`;
- reasoning effort: `xhigh` (极高).

## Authority and security

- `ALLRICE_PLATFORM_ADMIN_EMAILS` defines platform administrators. The default
  bootstrap owner is `semiokshen@gmail.com`.
- Tenant `admin` membership does not grant platform Provider administration.
- Connections store an opaque `credentialReference`, never an API key.
- Non-platform users receive a redacted connection view.
- Browsers never receive subscription tokens, API keys, vault paths or Codex
  authentication directories.
- Worker execution resolves a credential only after tenant, employee, Session
  and Run policy have been frozen.

## Session and routing semantics

An employee model policy is mutable configuration. A
`SessionModelSnapshot` is immutable execution evidence. Changing an employee's
model affects new Sessions; an existing Session remains pinned so its Harness
thread and replay remain coherent.

Every route decision records the model connection, catalog entry and policy
revision. Explicit fallback targets are resolved and frozen with the Session;
the router never silently selects an unlisted Provider. A fallback is observable
as `fallback_harness_selected` and retains its own connection identity.

## SaaS UI roles

- Member: works with assigned AI employees and sees the Harness label on each
  conversation.
- Tenant administrator: configures an employee from the published model pool.
- Platform administrator: additionally sees managed Provider health and owns
  connection publication.

All three roles use the same Web application. Visibility is derived from a
server-returned capability manifest and every mutation is independently
authorized by the server.
