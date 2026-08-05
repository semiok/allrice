# Employee workspace

> Status: **Planned**
>
> Linear: **MET-50**

## User outcome

After login, an enterprise employee lands in one coherent workspace: default personal AI employee, Session history, Chat, files, Memory context, Skill selection, task progress and results.

## V1 layout

- default AI employee entry;
- Session navigation and search;
- Chat conversation area;
- file attachment and context surface;
- basic Memory source/status surface;
- installed/favorite Skill picker after MET-44;
- Run progress and Artifact surface after MET-43.

## State authority

Business state is server-authoritative. Browser storage is limited to non-sensitive presentation preferences. Page refresh, browser restart and re-login restore the workspace from server records.

## Default AI employee

V1 provisions one default EmployeeVersion/Assignment per human user. The employee's model, system instructions and capabilities are versioned server configuration, not browser input. A complex editor and marketplace are deferred.

## Boundary

MET-50 owns the employee surface and the synchronous Chat/File/Memory loop. MET-43 owns background Run/SSE. MET-44 owns Skill installation and selection. MET-45 owns richer Employee lifecycle and audit.

## Failure behavior

The UI must distinguish empty state, loading, offline, timeout, permission denied, upload failure, AI failure and background Run state. Retrying must not create uncontrolled duplicate Messages or Jobs.

## Acceptance

- invited employee reaches the default workspace without a desktop application;
- creates and restores a Session;
- uploads and references a file;
- receives an answer with traceable Memory sources;
- refresh/re-login preserves state;
- User A cannot enumerate or open User B's workspace data;
- Web/PostgreSQL restart preserves the employee history.
