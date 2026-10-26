# Identity and tenancy

> Status: **MET-41 session, tenancy and RBAC foundation implemented; invitation links retired in MET-214**
>
> Linear: **MET-41, MET-49**
>
> First implementation target: post-0.1 baseline

## User outcome

A TNlabs platform administrator can add two human employees as two separate AllRice accounts. Each person signs in independently, receives a private employee workspace, and can also access explicitly shared TNlabs resources.

## Scope

- administrator-created accounts (no public sign-up, no invitation links);
- Organization, Workspace, Membership and Role;
- authenticated server Session lifecycle;
- RequestContext and unified authorization;
- account disable/revoke and audit;
- explicit, reviewed integration ports for future identity providers or
  organization directories.

## Non-goals in V1

- public registration;
- billing, SSO, SCIM or complex department hierarchy;
- shared login sessions with external products;
- administrator default access to private employee content.

## Authority and tenancy

AllRice V1 is authoritative for its users, organizations, memberships and
policies. An optional external identity provider may authenticate a principal
through a reviewed adapter, but it does not become the authority for AllRice
business data or policy snapshots.

Every private resource is authorized against `user_id`, `organization_id`, `workspace_id`, `owner_id` and `visibility`. The browser cannot select arbitrary tenant context.

## Core data

```text
users
organizations
workspaces
memberships
sessions
policies
policy_snapshots
audit_events
```

## API contract direction

- administrator account create/disable/password reset;
- login/logout/session refresh;
- current account and authorized workspace list;
- membership and role management;
- server-side `authorize(resource, action, context)`;
- explicit error codes for unauthenticated, forbidden, revoked, expired and tenant mismatch.

Canonical RequestContext, ExecutionContext, Membership, PolicySnapshot, roles, actions and deny reasons are frozen in `@allrice/contracts`.

Implemented routes:

- `POST /api/v1/auth/login`;
- `POST /api/v1/auth/logout`;
- `GET /api/v1/auth/session`;
- `POST /api/v1/admin/organizations/{id}/people`.

The first account is created only through the trusted `pnpm identity:bootstrap` command, or, with the portal login enabled, on the first sign-in with a deployment-configured portal credential (the platform administrator, and the legacy single-company portals such as Snow and Drink). There is no Auto Guest or committed default password. Invitation links were retired in MET-214 (migration `0221` drops their table).

## Security

- store passwords only through a mature password-hashing flow;
- rotate/revoke sessions;
- use secure, HTTP-only, same-site cookies;
- do not log tokens or password material;
- Worker re-authorizes and freezes PolicySnapshot before execution;
- administrators manage accounts but do not read private Chat/Memory by default.

## Acceptance

1. The administrator adds User A and User B; both receive separate IDs and sessions.
2. Each user sees only their private Sessions, files, Memory and SkillInstallation.
3. Both can access a TNlabs shared workspace according to Membership role.
4. Revoking User B invalidates new access and background execution.
5. Forged tenant/owner values are denied and audited.

## Current verification

- runtime schemas reject malformed login and tenant values;
- password and Session secret handling has unit coverage;
- canonical authorization tests cover cross-Organization, cross-Workspace and administrator access to another user's private resource;
- composite database keys reject cross-tenant Workspace references;
- production build contains login, Session and administrator account routes.
