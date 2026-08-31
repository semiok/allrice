# AllRice V1 architecture

## Objective

AllRice V1 provides an employee-facing AI workspace for a small, fixed enterprise user base. It favors a modular monolith and operational clarity over microservice scale.

The employee execution boundary is documented in [Harness Adapter and Employee Kernel](harness-adapter.md).
The Provider-neutral SaaS conversation control plane above the single DSH
Harness and its ChatFlow 3.0 native-event contract are documented in
[AllRice ChatFlow Runtime](chatflow-runtime.md).
The platform-managed Provider, model and employee selection boundary is
documented in [Platform-managed model pool](platform-model-pool.md).
The first-class Agent Skill, Workflow and Knowledge model is documented in
[Agent capability foundation](agent-capability-foundation.md).
The official, isolated DSH engineering WebUI and its authenticated publication
boundary are documented in [DSH administrator console](dsh-admin-console.md).
The Snow Mac local read-only execution boundary is documented in
[Rice Bridge v0.1](rice-bridge-v01.md).
DSH version isolation is documented in
[DSH upstream governance](../operations/dsh-upstream-governance.md), and the
product migration switch is documented in
[framework rollout](../operations/framework-rollout.md).

## Runtime topology

```text
Browser
  -> reverse proxy
  -> AllRice Web process
       -> ChatFlow Runtime (Session / Run / Event / recovery / Provider routing)
       -> PostgreSQL + pgvector
       -> object storage abstraction
       -> persistent Job / Run records
            -> Worker process
                 -> Scheduler module
                 -> DSH Harness / Provider router
                 -> Skill runtime
                 -> Memory
                 -> Artifact

Platform engineer browser
  -> reverse proxy
  -> authenticated DSH administrator gateway
       -> official DSH WebHost/WebUI on loopback
       -> isolated administrator DSH home
```

The tenant execution plane remains two AllRice application processes: Web and
Worker. Scheduler is code inside Worker, not a separately deployed process.
MET-87 adds one isolated engineering-only DSH administrator gateway; it never
executes a tenant Run and is not a third SaaS business service. Infrastructure
consists of PostgreSQL, mounted storage, and a reverse proxy.

## Authority

AllRice V1 operates independently. Its local invitation, Organization, Workspace, Membership, Policy, Session, Memory, SkillInstallation, and Run records are authoritative for the employee runtime.

OpenRice is the future enterprise-management authority for organization directory, roles, policy, Employee/Skill publishing and assignment. Integration is through versioned API, signed tokens, events, or explicit synchronization. Direct database sharing is prohibited.

## Trust boundaries

- Browser input is untrusted, including tenant IDs, roles, owner IDs, versions, and capabilities.
- Web authenticates and authorizes before every resource access.
- Worker re-authorizes at claim time and freezes a PolicySnapshot.
- Storage keys are tenant-scoped and never reveal host paths.
- Skill Artifact is immutable; local Worker materialization is disposable cache.
- Secret values never return to the browser or enter ordinary logs/Artifacts.

## Data boundaries

Every private or shared business resource must carry the appropriate subset of:

```text
organization_id
workspace_id
project_id
owner_id
visibility
created_at
updated_at
```

Tenant isolation is enforced in repository/authorization boundaries and verified with allow/deny tests. It must not depend on callers remembering to add a filter.

## Contract-first rule

MET-49 freezes the following before business implementation:

- IDs and tenant ownership;
- RequestContext, ExecutionContext, Authorization and PolicySnapshot;
- Queue state, claim, lease, heartbeat, retry, cancellation and recovery;
- Run, RunEvent, Artifact, Approval and Audit;
- SSE Last-Event-ID, replay and reconnect;
- Skill Version, Artifact, Installation and capability grants;
- Agent Skill, Workflow and Knowledge revisions, employee bindings and ACLs;
- Storage keys, signed access, retention and backup;
- API and migration version compatibility.

MET-49 freezes these definitions in [`@allrice/contracts`](../../packages/contracts/README.md), [ADR-0001](adr-0001-v1-core-contract-authority.md), the [core-contract reference](v1-core-contracts.md), [schema draft](v1-schema-draft.sql), and [test matrix](v1-contract-test-matrix.md).

## Explicit V1 exclusions

- desktop application and native operating-system integration;
- Redis, Kubernetes, microservices, multi-region deployment;
- public registration, billing and enterprise SSO;
- arbitrary unreviewed script execution;
- complete Employee marketplace/editor, broad Connector catalog and Loop automation.
