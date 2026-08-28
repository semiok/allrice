# Agent capability foundation

> Status: **MET-92 / DSH-native Skill foundation implemented**

AllRice models an AI employee's abilities as three independent capability
families. They share publication, binding and audit conventions, but do not
share a generic JSON table:

- **Agent Skill** is a DSH-native reusable ability. AllRice stores the reviewed
  definition, required Tool references and invocation policy, then exposes an
  immutable employee-scoped snapshot through `AllRiceSkillProvider`.
- **Workflow** describes a deterministic, ordered graph of approved steps.
  Phase 2.1 stores and binds the immutable definition; durable execution is
  delivered by MET-73.
- **Knowledge** describes an approved data source plus immutable access list.
  Phase 2.1 resolves who may use the source; connector ingestion and retrieval
  are delivered by MET-72.

## Lifecycle and authority

```text
administrator creates definition
  -> immutable published revision
       -> administrator binds exact revision to employee
            -> runtime intersects actor + tenant + ACL + active state
                 -> exact effective binding is frozen into EmployeeRun
```

DSH-native Skill definitions are enabled or disabled by the platform
administration plane. A binding points to one exact checksum; changing content
never mutates a running Session and instead changes the runtime fingerprint for
the next Session.

Only the platform administration plane may create or bind DSH-native Skills.
Tenant users do not install Skills. Required Tool references must be present in
the frozen Run grant or the Skill is omitted from that DSH runtime.

## Knowledge access

A Knowledge revision includes its ACL in the revision checksum. The ACL is
immutable after publication and may name an organization, workspace, employee
or user principal. At run preparation, AllRice keeps a Knowledge binding only
when at least one ACL entry matches the current organization, workspace,
employee or actor. A successful administrator binding therefore does not imply
that every assigned user can read the source.

Connector credentials are referenced only by opaque `connectorBindingId`.
Secrets are never stored in the capability definition, API response, execution
snapshot, prompt or audit metadata.

## Execution snapshot

Each EmployeeRun freezes:

- the exact DSH-native Skill ID, body, checksum, invocation policy and required
  Tool references;
- the exact Workflow revision and checksum;
- the exact Knowledge revision, ACL and actor-effective access entries;
- the actor for whom the directory was resolved;
- the existing employee definition, assignment, runtime and policy context.

Administration edits affect only future runs. A Worker never resolves a moving
"latest" capability after it has claimed a run.

## Fresh baseline

Migration `0046` removes the legacy catalog, versions, installations,
artifacts and bindings. Migration `0047` removes unused built-in employees so
the initial catalog contains only Rice. There is no ID mapping, dual-write or
fallback path.

## Administrative API

- `GET /api/v1/admin/capabilities?workspaceId=...` lists the catalog.
- `POST /api/v1/admin/capabilities` creates a Workflow or Knowledge source and
  its first published revision.
- `POST /api/v1/admin/capabilities/:id/revisions` publishes a new immutable
  revision.
- `PATCH /api/v1/admin/capabilities/:id/revisions` deprecates or revokes an
  Agent Skill, Workflow or Knowledge revision.
- `PATCH /api/v1/admin/capabilities/:id` archives or restores a definition.
- `GET /api/v1/employees/:id/capabilities?workspaceId=...` returns an
  administrator view of exact bindings.
- `PUT /api/v1/employees/:id/capabilities` atomically replaces the employee's
  Agent Skill, Workflow and Knowledge bindings.

The legacy capability endpoints are not the DSH-native Skill authority. MET-93
adds the platform-only employee configuration and publication surface.
