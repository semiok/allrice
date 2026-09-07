# Shared contracts

`@allrice/contracts` is the only allowed authority for types that cross Web, Worker, persistence, and streaming boundaries.

Version 0.1.0 defines runtime-validated contracts for tenancy, authorization, Queue, Run/Event, SSE replay, DSH-native Skill snapshots, Agent Skill / Workflow / Knowledge bindings, Storage, API compatibility and health.

Packages must import these definitions instead of recreating local variants. Boundary data is parsed with the exported Zod schemas; TypeScript types alone are not a trust boundary.

The normative design and compatibility rules are in [ADR-0001](../../docs/architecture/adr-0001-v1-core-contract-authority.md) and the [V1 core-contract document](../../docs/architecture/v1-core-contracts.md).

Employee capability lifecycle and snapshot semantics are documented in the
[Agent capability foundation](../../docs/architecture/agent-capability-foundation.md).

## AllRice 2.0 candidate contracts (P01 / MET-110)

The additive [runtime-v2](src/runtime-v2/index.ts) exports describe task references,
operation attempts, typed interactions, ordered evidence and usage observations.
They are **not connected to production adapters** and grant no new capability.
Existing RunEvent v1, ChatFlow v3 and Bridge v1/v2 contracts remain unchanged.

See [P01 mapping and compatibility](../../docs/architecture/allrice-2.0/p01-runtime-contracts.md)
for identity mapping, trust prerequisites, replay semantics and deferred integration.
The local pure validators do not implement authorization, transactional approval
consumption, durable deduplication, process termination or a second task ledger.
