# Identity and tenancy

> Status: **MET-49 contract frozen; implementation pending MET-41**
>
> Linear: **MET-41, MET-49**
>
> First implementation target: post-0.1 baseline

## User outcome

TNlabs can invite two human employees as two separate AllRice accounts. Each person signs in independently, receives a private employee workspace, and can also access explicitly shared TNlabs resources.

## Scope

- local invitation and account activation;
- Organization, Workspace, Membership and Role;
- authenticated server Session lifecycle;
- RequestContext and unified authorization;
- account disable/revoke and audit;
- IdentityProvider and OrganizationDirectory ports for future OpenRice integration.

## Non-goals in V1

- public registration;
- billing, SSO, SCIM or complex department hierarchy;
- shared login sessions with OpenRice;
- administrator default access to private employee content.

## Authority and tenancy

AllRice V1 is authoritative for its local users and memberships and cannot require OpenRice online. In a future managed mode, OpenRice becomes authority for enterprise directory and policy while AllRice stores a verified local projection and PolicySnapshot.

Every private resource is authorized against `user_id`, `organization_id`, `workspace_id`, `owner_id` and `visibility`. The browser cannot select arbitrary tenant context.

## Core data

```text
users
organizations
workspaces
memberships
sessions
invitations
policies
policy_snapshots
audit_events
```

## API contract direction

- invitation create/accept/revoke;
- login/logout/session refresh;
- current account and authorized workspace list;
- membership and role management;
- server-side `authorize(resource, action, context)`;
- explicit error codes for unauthenticated, forbidden, revoked, expired and tenant mismatch.

Canonical RequestContext, ExecutionContext, Membership, PolicySnapshot, roles, actions and deny reasons are frozen in `@allrice/contracts`. MET-41 owns routes, persistence and session implementation.

## Security

- store passwords only through a mature password-hashing flow;
- rotate/revoke sessions and invitation tokens;
- use secure, HTTP-only, same-site cookies;
- do not log tokens, password material or invitation secrets;
- Worker re-authorizes and freezes PolicySnapshot before execution;
- administrators manage accounts but do not read private Chat/Memory by default.

## Acceptance

1. TNlabs invites User A and User B; both receive separate IDs and sessions.
2. Each user sees only their private Sessions, files, Memory and SkillInstallation.
3. Both can access a TNlabs shared workspace according to Membership role.
4. Revoking User B invalidates new access and background execution.
5. Forged tenant/owner values are denied and audited.
