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
                      -> DSH Harness -> selected Provider
```

The default platform selection is:

- Harness: DSH;
- Provider: `openai-codex`;
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
model affects new Sessions; an existing Session remains pinned so its DSH
session and replay remain coherent.

Every route decision records the model connection, catalog entry and policy
revision. Explicit fallback targets are resolved and frozen with the Session;
the router never silently selects an unlisted Provider. A fallback is observable
as `fallback_provider_selected`, records the source decision and classified
failure condition, and retains its own connection identity. A failed attempt is
never replayed onto another Provider inside the same attempt; eligible fallback
is selected by the durable retry path so partially completed side effects cannot
be duplicated silently.

## Platform subscription broker

Codex subscription authorization is a platform operation executed through the
DSH `openai-codex` OAuth flow. DSH's official credential service writes and
refreshes the grant in a private platform Harness home. PostgreSQL stores only
the public verification URI/code, flow state and an opaque credential
reference. OAuth tokens and filesystem paths are never returned to the browser
or written to application tables. Codex CLI is not used for model execution.

## Quota and Provider governance

- Every terminal route decision writes one idempotent monthly usage-ledger row.
- Tenant run, Token and cost quotas are checked before routing.
- Three consecutive classified Provider failures open a 60-second circuit;
  success closes the circuit and writes a recovery incident.
- Platform administrators can reset a circuit or use an audited per-Provider
  emergency kill switch.
- Per-run timeout, input, output, total-Token and cost limits are frozen in the
  Session policy.
- Cost pricing is deployment-owned through `ALLRICE_MODEL_PRICING_JSON`; missing
  pricing is explicit zero rather than an invented estimate.

## SaaS UI roles

- Member: works with assigned AI employees and sees the Provider/model label on
  each conversation; the Harness is consistently DSH.
- Tenant administrator: configures an employee from the published model pool.
- Platform administrator: additionally sees managed Provider health and owns
  connection publication.

All three roles use the same Web application. Visibility is derived from a
server-returned capability manifest and every mutation is independently
authorized by the server.
