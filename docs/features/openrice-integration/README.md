# OpenRice integration

> Status: **Contract pending; not required for AllRice V1 runtime**
>
> Linear: **MET-49**

The source capability and license decisions that constrain this integration are recorded in the [MET-40 OpenRice extraction audit](../../audits/openrice-extraction-audit.md).

## Product boundary

OpenRice faces enterprise managers. AllRice faces enterprise employees. OpenRice is the future management authority for enterprise directory, role/policy, Employee/Skill publishing and assignment. AllRice remains authoritative for employee runtime state such as Session, private Memory, Skill favorite and Run history.

## V1 independence

AllRice V1 uses local invitations and minimal Organization/Workspace policy. It must start and work when OpenRice is absent or unavailable. OpenRice is not a runtime dependency for the first release.

## Future integration methods

Only the following are permitted:

- versioned HTTPS APIs;
- signed short-lived identity/service tokens;
- versioned events with idempotent consumers;
- explicit synchronization with checkpoint, conflict and recovery reporting.

Direct table access, shared ORM models, shared migrations, shared runtime directories and implicit filesystem contracts are prohibited.

## Required claims and versions

The contract must define subject, organization, workspace, role, grants, policy version, issued time, expiry, issuer, audience and key rotation. AllRice stores a verified projection and freezes PolicySnapshot for a Run.

## Outage behavior

If OpenRice is unavailable, AllRice uses the last verified projection for low-risk operations within expiry policy or explicitly blocks high-risk operations. It never silently widens permissions.

## Privacy

Enterprise management does not imply default access to private employee Chat or Memory. Audit/aggregate data shared back to OpenRice must follow a documented policy and minimize content.

## Acceptance

- AllRice operates with OpenRice offline;
- forged/expired/wrong-audience tokens fail;
- synchronization is idempotent and reports conflict/failure;
- policy revocation reaches new Runs;
- no integration test reads another product's tables directly.
