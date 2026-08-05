# Memory

> Status: **MET-42 foundation and MET-50 explicit workflows implemented**
>
> Linear: **MET-42, MET-50**

## User outcome

AllRice can remember approved facts and source material for an employee while keeping private and team Memory isolated and explainable.

## Scope

- Memory documents and chunks from allowed Chat/file/user actions;
- pgvector embeddings and tenant-filtered retrieval;
- source attribution in answers;
- employee-visible source inspection and private Memory deletion;
- delete propagation to chunks and future retrieval.

## Non-goals in V1

- unrestricted automatic extraction from every conversation;
- global organization knowledge graph;
- administrator default access to private employee Memory;
- cross-product shared vector tables with OpenRice.

## Implemented data foundation

`allrice_memories` and `allrice_rag_chunks` store explicit organization, workspace, owner and visibility. Chunks use `vector(1536)` with an HNSW cosine index. Chat Session, Message and Run authority tables now carry the same tenant columns for their owning feature work.

Migration `0004_employee_workspace.sql` adds user/message/file source type and source ID plus an embedding-model marker. Explicit browser actions create Memory through server-derived deterministic embeddings; the browser cannot supply an embedding vector.

## Retrieval boundary

Authorization and tenant filters are applied inside the SQL recall query, never after receiving an unrestricted result set. `POST /api/v1/memories/recall` accepts text, derives its vector on the server, always binds organization and workspace, and allows private chunks only when `owner_id` matches the authenticated actor. The workspace lists sources and supports owner deletion through `/api/v1/memories/:id`.

## Failure and recovery

Deleting a Memory removes its chunks in the same transaction. Deleting a file archives file-sourced Memory, removes the corresponding chunks and revokes signed grants. A future production embedding model must use a new version marker and migration instead of silently changing vector meaning.

## Acceptance

- private Memory is retrieved only for its owner (covered by two-user Compose smoke);
- explicitly shared Memory follows Workspace role;
- User B cannot retrieve User A's vector matches;
- source attribution resolves to an authorized source;
- deletion prevents future retrieval;
- backup/restore preserves document/chunk ownership and version metadata.
