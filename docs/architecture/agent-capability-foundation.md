# Agent capability foundation

> Status: **MET-68 / Employee Framework Phase 2.1 implemented**

AllRice models an AI employee's abilities as three independent capability
families. They share publication, binding and audit conventions, but do not
share a generic JSON table:

- **Agent Skill** describes a reusable, model-invoked ability. In Phase 2.1 it
  reuses the immutable SkillHub artifact and pinned SkillVersion authority,
  extended with applicable scenarios, input/output schemas, required Tool
  references and a risk level.
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

Definitions have an `active` or `archived` catalog status. Revisions have a
`draft`, `published`, `deprecated` or `revoked` lifecycle. A binding always
points to one exact published revision; publishing a newer revision never
silently changes an existing employee.

Only an active workspace or organization administrator may create, publish,
archive or bind capabilities. Agent Skill bindings additionally require an
enabled workspace Skill installation, its pinned published SkillVersion, a
ready immutable artifact, and grants that are a subset of the Skill's declared
capabilities.

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

`EmployeeExecutionSnapshot` schema version 2 freezes:

- the exact Agent Skill revision, installation and granted capabilities;
- the exact Workflow revision and checksum;
- the exact Knowledge revision, ACL and actor-effective access entries;
- the actor for whom the directory was resolved;
- the existing employee definition, assignment, runtime and policy context.

Catalog edits affect only future runs. A Worker never resolves a moving
"latest" capability after it has claimed a run.

## Rolling compatibility

Migration `0020` backfills existing manifest-based Skill selections into the
explicit binding table. Migration `0022` temporarily mirrors manifests written
by an older Web process until the new service explicitly manages that
employee's bindings. Once `skill_bindings_managed_at` is set, the explicit
binding table is authoritative and the legacy mirror no longer changes it.

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

These APIs are the backend authority for the configuration center planned in
MET-69. They are not exposed as a new end-user navigation item.
