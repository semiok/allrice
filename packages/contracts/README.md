# Shared contracts

`@allrice/contracts` is the only allowed authority for types that cross Web, Worker, persistence, and streaming boundaries.

Version 0.1.0 defines runtime-validated V1 contracts for tenancy, authorization, Queue, Run/Event, SSE replay, SkillHub, Storage, API compatibility and health.

Packages must import these definitions instead of recreating local variants. Boundary data is parsed with the exported Zod schemas; TypeScript types alone are not a trust boundary.

The normative design and compatibility rules are in [ADR-0001](../../docs/architecture/adr-0001-v1-core-contract-authority.md) and the [V1 core-contract document](../../docs/architecture/v1-core-contracts.md).
