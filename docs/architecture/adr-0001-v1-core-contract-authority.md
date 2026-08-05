# ADR-0001: V1 core contract authority

> Status: Accepted for V1 implementation
>
> Date: 2026-08-05
>
> Linear: MET-49

## Context

Identity, Web, Worker, Queue, streaming, SkillHub and Storage all need the same tenant, actor, policy, event and version semantics. Defining similar interfaces inside each application would make authorization drift and rolling upgrades inevitable.

## Decision

`@allrice/contracts` is the only source-code authority for objects crossing process, persistence, API or event boundaries. It owns runtime Zod schemas and inferred TypeScript types for:

- identifiers, actors, tenancy, ownership and visibility;
- RequestContext, ExecutionContext, Membership, PolicySnapshot and authorization decisions;
- Job payloads, leases, states, retries and recovery transitions;
- RunEvent, Artifact and AuditEvent envelopes;
- SSE cursor parsing and replay;
- CatalogSkill, SkillVersion, SkillArtifact and SkillInstallation;
- StorageObject, signed grants and tenant-prefixed object keys;
- API versions, error codes and compatibility windows.

Applications may add private implementation types, but they must parse every boundary value with the canonical schema and cannot redefine a canonical object.

## Consequences

- Web and Worker reject malformed or incompatible payloads at entry.
- Worker executes only against an immutable PolicySnapshot and re-authorizes resources at claim time.
- PostgreSQL schemas and API payloads must map to the canonical contracts.
- Contract changes require a schema version, compatibility decision, tests and documentation.
- OpenRice integration translates into these contracts; it never imports OpenRice ORM models or tables.
