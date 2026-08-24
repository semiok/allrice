# Chat and Session

> Status: **Durable AI employee Chat/Session implemented**
>
> Linear: **MET-50**

## User outcome

Employees can create, name, archive, restore and continue conversations with a selected AI employee. Messages, attachments, employee memories, references and errors survive page and service restarts.

## Data model direction

```text
allrice_chat_sessions
allrice_messages
allrice_message_attachments
allrice_file_references
allrice_conversation_runtimes
allrice_audit_events
```

Each Chat Session stores an immutable `employee_assignment_id` and
`employee_version_id` selected when the task is created. The version is an
internal execution snapshot; users choose the employee, not the version.

Messages support user, assistant, system and tool roles. The model will include stable IDs, ordering, creation status, error status, tenant ownership and an idempotency key for client retries.

## API behavior

- list/create/update/archive Sessions;
- list Messages with stable pagination/order;
- append user Message with idempotency protection;
- persist a pending assistant Message and enqueue an idempotent EmployeeRun;
- reference uploaded files and Memory sources;
- return `202` with the Run identity rather than holding the Web request open;
- recover the completed/failed/canceled assistant result from PostgreSQL.

The routes are `/api/v1/sessions`, `/api/v1/sessions/:id`, `/api/v1/sessions/:id/messages` and `/api/v1/sessions/:id/attachments`. List pagination uses an opaque `(updated_at, id)` cursor. A `clientMessageId`, transaction advisory lock and `employee-message:<clientMessageId>` queue key make retries return the original Message pair and Run.

## Authorization

Every list/get/mutation applies organization, workspace, owner, visibility and Membership policy. IDs are never sufficient authorization. Shared Sessions expose only explicitly shared Messages and referenced resources.

## Failure and recovery

- client retry reuses an idempotency key;
- partial assistant output records a clear failed/canceled state;
- refresh resumes persisted content rather than reconstructing from localStorage;
- background work returns through the MET-43 Run state/event ledger;
- every Session resumes its persisted Codex thread while PostgreSQL owns the
  active run/turn/Worker binding;
- each Session resumes its own Codex thread and employee-version binding rather
  than following a later global default change;
- archive is reversible; deletion follows retention and audit policy.

## Acceptance

The HTTP smoke covers two users and two Workspaces, private-ID denial, explicit sharing with private attachment masking, duplicate Message/Run submission, refresh/re-login and Web/PostgreSQL restart. Cursor pagination is implemented at the repository/API boundary; Queue timeout, cancellation and RunEvent replay are provided by MET-43.
