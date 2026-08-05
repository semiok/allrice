# Employee workspace

> Status: **MET-50 synchronous workspace implemented**
>
> Linear: **MET-50**

## User outcome

After login, an enterprise employee lands in one coherent workspace with a default personal AI employee, persistent Session history, synchronous Chat, attachments and explicit Memory. Skill selection, background task progress and results remain intentionally owned by MET-44 and MET-43.

## V1 layout

- default AI employee entry;
- Session navigation, naming, sharing, archive and restore;
- Chat conversation area;
- file attachment and context surface;
- basic Memory source/status surface;
- installed/favorite Skill picker after MET-44;
- Run progress and Artifact surface after MET-43.

## State authority

Business state is server-authoritative. Browser storage is limited to non-sensitive presentation preferences. Page refresh, browser restart and re-login restore the workspace from server records.

## Default AI employee

V1 provisions one default EmployeeVersion/Assignment per human user. The employee's model, system instructions and capabilities are versioned server configuration, not browser input. A complex editor and marketplace are deferred.

`GET /api/v1/workspace` lazily provisions the immutable `AllRice Guide` version and the user's default assignment, then restores active and archived Sessions plus authorized Memory. The browser stores no business authority.

## Implemented API surface

- `GET /api/v1/workspace` restores the assigned employee and workspace state;
- `GET|POST /api/v1/sessions` and `GET|PATCH /api/v1/sessions/:id` manage conversations;
- `POST /api/v1/sessions/:id/messages` persists an idempotent user/assistant pair before returning synchronous SSE events;
- `POST /api/v1/sessions/:id/attachments` validates, stores and references an allowlisted private attachment;
- Memory and signed file APIs provide explicit remember, inspect, download and delete actions.

## Boundary

MET-50 owns the employee surface and the synchronous Chat/File/Memory loop. MET-43 owns background Run/SSE. MET-44 owns Skill installation and selection. MET-45 owns richer Employee lifecycle and audit.

## Failure behavior

The UI must distinguish empty state, loading, offline, timeout, permission denied, upload failure, AI failure and background Run state. Retrying must not create uncontrolled duplicate Messages or Jobs.

## Acceptance

- invited employee reaches the default workspace without a desktop application;
- creates, archives, restores and continues a Session;
- uploads, references, downloads and deletes a private file;
- receives a synchronous answer with authorized Memory citations;
- refresh/re-login restores state from PostgreSQL and object storage;
- two-user/two-workspace smoke coverage denies tenant enumeration and masks private attachments in a shared Session;
- Web/PostgreSQL restart preserves employee, Session, Message, attachment and Memory history.
