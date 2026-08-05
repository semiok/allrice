# Memory

> Status: **MET-42 storage/retrieval foundation implemented; product workflows pending MET-50**
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

Documents and chunks carry organization, workspace, owner, visibility, source ID, embedding model/version and lifecycle status.

## Retrieval boundary

Authorization and tenant filters are applied inside the SQL recall query, never after receiving an unrestricted result set. `POST /api/v1/memories/recall` always binds organization and workspace and allows private chunks only when `owner_id` matches the authenticated actor.

## Failure and recovery

Embedding failures are retryable and visible. Deleting a source invalidates corresponding chunks. Re-embedding creates a versioned transition, not silent incompatible vector reuse.

## Acceptance

- private Memory is retrieved only for its owner (covered by two-user Compose smoke);
- explicitly shared Memory follows Workspace role;
- User B cannot retrieve User A's vector matches;
- source attribution resolves to an authorized source;
- deletion prevents future retrieval;
- backup/restore preserves document/chunk ownership and version metadata.
