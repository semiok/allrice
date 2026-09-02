# Employee workspace

> Status: **Rice tenant work surface with durable DSH execution implemented**
>
> Linear: **MET-50 / MET-88 / MET-93**

## User outcome

After login, a tenant user works with the AI employees published to that
workspace. Rice is the only seeded employee today. Platform administrators
configure and publish employee runtime packages from the Runtime Console;
tenant users consume those packages and cannot create employees, edit their
models or install Skills.

## Current layout

- one ChatFlow 3.0 work surface for durable Sessions and Runs;
- recent Session navigation and a new-work entry;
- DSH-native Context, Search, Think, Tool and Answer event projection;
- local and workspace attachments with tenant-safe visibility;
- a read-only employee detail view for identity, published Skills and model;
- Rice Bridge status for an explicitly authorized local workspace;
- no tenant EmployeeHub or SkillHub administration surface.

## State authority

Business state is server-authoritative. Browser storage is limited to non-sensitive presentation preferences. Page refresh, browser restart and re-login restore the workspace from server records.

## Published AI employees

The platform currently provisions Rice only. The platform employee production
flow owns employee identity, native DSH Skills, model policy, tools, safety and
tenant publication. An immutable published runtime package is frozen into a
new Session; tenants select or summon an employee, never an internal version.
Additional employees can be introduced later through the same platform-owned
publication flow without exposing configuration authority to tenants.

The employee safety profile also records an explicit external-action approval
preference. `confirm_side_effects` remains the internal contract name: the
employee may analyze and prepare work, but must explain and ask before changes,
external communication, publishing, booking, deletion or similar actions.
Actual authorization is enforced by Tool grants and execution policy, not by
prompt text alone.

`GET /api/v1/workspace` restores published employee assignments, Sessions and
authorized Memory. Each Session keeps its frozen employee runtime package and
DSH Provider/model identity. The browser stores no business authority.

## Implemented API surface

- `GET /api/v1/workspace` restores the assigned employee and workspace state;
- `GET|POST /api/v1/sessions` and `GET|PATCH /api/v1/sessions/:id` manage conversations;
- `POST /api/v1/sessions/:id/messages` persists an idempotent user/pending-assistant pair and returns its durable EmployeeRun;
- `POST /api/v1/sessions/:id/attachments` validates, stores and references an allowlisted private attachment;
- Memory and signed file APIs provide governed workspace memory and employee-scoped recall;
- the Runtime Console owns employee configuration, preview and tenant publication.

## Boundary

MET-50 owns the base workspace and Chat/File/Memory records. ChatFlow 3.0 owns
the transparent SaaS conversation control plane. DSH is the only Harness.
MET-92/MET-93 own native Skill governance and platform employee production;
retired SkillHub bindings are not a current authorization source.

## Failure behavior

The UI must distinguish empty state, loading, offline, timeout, permission denied, upload failure, AI failure and background Run state. Retrying must not create uncontrolled duplicate Messages or Jobs.

## Acceptance

- invited tenant reaches the Rice work surface without a desktop application;
- creates, archives, restores and continues a Session;
- uploads, references, downloads and deletes a private file;
- receives a durable Rice answer with authorized Memory, published Skills and frozen execution evidence;
- refresh/re-login restores state from PostgreSQL and object storage;
- two-user/two-workspace smoke coverage denies tenant enumeration and masks private attachments in a shared Session;
- Web/PostgreSQL restart preserves employee, Session, Message, attachment and Memory history.
