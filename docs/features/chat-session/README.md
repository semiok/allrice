# Chat and Session

> Status: **MET-50 synchronous Chat/Session implemented**
>
> Linear: **MET-50**

## User outcome

Employees can create, name, archive, restore and continue conversations with their assigned AI employee. Messages, attachments, references and errors survive page and service restarts.

## Data model direction

```text
allrice_chat_sessions
allrice_messages
allrice_message_attachments
allrice_file_references
allrice_audit_events
```

Messages support user, assistant, system and tool roles. The model will include stable IDs, ordering, creation status, error status, tenant ownership and an idempotency key for client retries.

## API behavior

- list/create/update/archive Sessions;
- list Messages with stable pagination/order;
- append user Message with idempotency protection;
- stream a short synchronous assistant response;
- reference uploaded files and Memory sources;
- transition long work into MET-43 Run/SSE rather than holding a Web request indefinitely.

The routes are `/api/v1/sessions`, `/api/v1/sessions/:id`, `/api/v1/sessions/:id/messages` and `/api/v1/sessions/:id/attachments`. List pagination uses an opaque `(updated_at, id)` cursor. A `clientMessageId` and a transaction advisory lock make retries return the original user/assistant pair.

## Authorization

Every list/get/mutation applies organization, workspace, owner, visibility and Membership policy. IDs are never sufficient authorization. Shared Sessions expose only explicitly shared Messages and referenced resources.

## Failure and recovery

- client retry reuses an idempotency key;
- partial assistant output records a clear failed/canceled state;
- refresh resumes persisted content rather than reconstructing from localStorage;
- background work will return through RunEvent replay after MET-43;
- archive is reversible; deletion follows retention and audit policy.

## Acceptance

The Compose smoke covers two users and two Workspaces, private-ID denial, explicit sharing with private attachment masking, duplicate submission, refresh/re-login and Web/PostgreSQL restart. Cursor pagination is implemented at the repository/API boundary. Timeout, cancellation and RunEvent replay remain MET-43 scope.
