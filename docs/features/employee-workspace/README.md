# Employee workspace

> Status: **Independent AI employees with durable execution implemented**
>
> Linear: **MET-50**

## User outcome

After login, an enterprise employee lands in one coherent workspace where each new task can select an independent AI employee. Each employee has its own Skill configuration, memory and durable conversation history.

## V1 layout

- default AI employee entry;
- Session navigation, naming, sharing, archive and restore;
- Chat conversation area;
- file attachment and context surface;
- basic Memory source/status surface;
- an AI employee selector used when creating a task;
- a task launchpad that exposes the selected employee's role, mission, Skill/Memory context and execution-confirmation boundary;
- EmployeeHub and SkillHub navigation;
- pending, completed and failed Run-backed Message state.

## State authority

Business state is server-authoritative. Browser storage is limited to non-sensitive presentation preferences. Page refresh, browser restart and re-login restore the workspace from server records.

## Independent AI employees

The system provisions Rice plus built-in employees for e-commerce analysis, short-video growth, fitness management, sales coaching, growth strategy and e-commerce campaign pages. Users can also create additional employees. An EmployeeVersion is an internal immutable configuration snapshot; users select employees, not versions. Each employee can have its own Skill bindings and employee-scoped memories.

The employee `PartnerProfile` also records an explicit execution-confirmation
preference. `confirm_side_effects` is the default: the employee may analyze and
prepare work, but must explain and ask before changes, external communication,
publishing, booking, deletion or other side effects. This preference is frozen
into the EmployeeVersion prompt snapshot and shown at task creation time;
actual authorization remains enforced by capabilities, Skill grants and the
execution policy.

`GET /api/v1/workspace` lazily provisions Rice and restores all active employee assignments, active/archived Sessions and authorized Memory. Each Session keeps its own employee assignment and version binding. The browser stores no business authority.

## Implemented API surface

- `GET /api/v1/workspace` restores the assigned employee and workspace state;
- `GET|POST /api/v1/sessions` and `GET|PATCH /api/v1/sessions/:id` manage conversations;
- `POST /api/v1/sessions/:id/messages` persists an idempotent user/pending-assistant pair and returns its durable EmployeeRun;
- `POST /api/v1/sessions/:id/attachments` validates, stores and references an allowlisted private attachment;
- Memory and signed file APIs provide workspace memory plus employee-scoped remember and inspect actions.

## Boundary

MET-50 owns the base workspace, Chat/File/Memory records. MET-43 owns the durable execution plane, MET-44 owns immutable Skill installation, and MET-45 composes them through employee manifests, Assignments and EmployeeRuns.

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
