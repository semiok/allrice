# Chat and Session

> Status: **Planned**
>
> Linear: **MET-50**

## User outcome

Employees can create, name, archive, restore and continue conversations with their assigned AI employee. Messages, attachments, references and errors survive page and service restarts.

## Data model direction

```text
chats
messages
message_attachments
message_references
audit_events
```

Messages support user, assistant, system and tool roles. The model will include stable IDs, ordering, creation status, error status, tenant ownership and an idempotency key for client retries.

## API behavior

- list/create/update/archive Sessions;
- list Messages with stable pagination/order;
- append user Message with idempotency protection;
- stream a short synchronous assistant response;
- reference uploaded files and Memory sources;
- transition long work into MET-43 Run/SSE rather than holding a Web request indefinitely.

Exact API names are deferred to MET-49.

## Authorization

Every list/get/mutation applies organization, workspace, owner, visibility and Membership policy. IDs are never sufficient authorization. Shared Sessions expose only explicitly shared Messages and referenced resources.

## Failure and recovery

- client retry reuses an idempotency key;
- partial assistant output records a clear failed/canceled state;
- refresh resumes persisted content rather than reconstructing from localStorage;
- background work returns through RunEvent replay;
- archive is reversible; deletion follows retention and audit policy.

## Acceptance

Two-user tests cover ID enumeration, shared/private visibility, duplicate submit, pagination, refresh, re-login, timeout, cancellation and service restart.
