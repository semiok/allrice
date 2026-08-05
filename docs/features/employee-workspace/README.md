# Employee workspace

> Status: **Rice workspace with durable execution implemented**
>
> Linear: **MET-50**

## User outcome

After login, an enterprise employee lands in one coherent workspace with Rice selected as the default AI employee, persistent Session history, durable Codex-backed Chat, attachments, explicit Memory and links to EmployeeHub and SkillHub.

## V1 layout

- default AI employee entry;
- Session navigation, naming, sharing, archive and restore;
- Chat conversation area;
- file attachment and context surface;
- basic Memory source/status surface;
- an AI employee selector used when creating a Session;
- EmployeeHub and SkillHub navigation;
- pending, completed and failed Run-backed Message state.

## State authority

Business state is server-authoritative. Browser storage is limited to non-sensitive presentation preferences. Page refresh, browser restart and re-login restore the workspace from server records.

## Default AI employee

V1 provisions one default EmployeeVersion/Assignment per human user. The employee's model, system instructions and capabilities are versioned server configuration, not browser input. A complex editor and marketplace are deferred.

`GET /api/v1/workspace` lazily provisions immutable Rice version 2 and the user's explicit default assignment, then restores all active employee assignments, active/archived Sessions and authorized Memory. The browser stores no business authority.

## Implemented API surface

- `GET /api/v1/workspace` restores the assigned employee and workspace state;
- `GET|POST /api/v1/sessions` and `GET|PATCH /api/v1/sessions/:id` manage conversations;
- `POST /api/v1/sessions/:id/messages` persists an idempotent user/pending-assistant pair and returns its durable EmployeeRun;
- `POST /api/v1/sessions/:id/attachments` validates, stores and references an allowlisted private attachment;
- Memory and signed file APIs provide explicit remember, inspect, download and delete actions.

## Boundary

MET-50 owns the base workspace, Chat/File/Memory records. MET-43 owns the durable execution plane, MET-44 owns immutable Skill installation, and MET-45 composes them through Rice manifests, Assignments and EmployeeRuns. Rich employee editors and multi-employee catalogs remain deferred.

## Failure behavior

The UI must distinguish empty state, loading, offline, timeout, permission denied, upload failure, AI failure and background Run state. Retrying must not create uncontrolled duplicate Messages or Jobs.

## Acceptance

- invited employee reaches the default workspace without a desktop application;
- creates, archives, restores and continues a Session;
- uploads, references, downloads and deletes a private file;
- receives a durable Rice answer with authorized Memory citations and frozen execution evidence;
- refresh/re-login restores state from PostgreSQL and object storage;
- two-user/two-workspace smoke coverage denies tenant enumeration and masks private attachments in a shared Session;
- Web/PostgreSQL restart preserves employee, Session, Message, attachment and Memory history.
