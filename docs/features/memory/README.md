# Memory 2.0

> Status: **MET-98 P1-1 implemented on the development branch**
>
> Linear: **MET-42, MET-50, MET-98**

## User outcome

Rice can recover relevant preferences, project facts and decisions across Sessions without treating every sentence as permanent truth. Users remain in control: they can confirm a candidate, correct a long-term memory or delete it.

## Architecture

AllRice borrows the useful separation from OpenClaw between working context and durable memory, but PostgreSQL remains the only source of truth for the multi-tenant SaaS platform. Markdown files are not a parallel memory database.

The lifecycle has three layers:

1. **Session context** is the current conversation and its compacted checkpoint.
2. **Candidate memory** is a reviewable, user-authored preference, decision, project fact or work note. It is never automatically injected.
3. **Durable memory** is explicitly confirmed by the user and may be recalled in later Sessions when relevant.

Knowledge and Workflow remain separate governed capabilities. They are not relabelled as Memory.

## Capture rules

- `workspace.memory.remember` writes a candidate only from a stable statement in the current user message.
- A durable write requires an explicit current-message instruction such as “请记住” or “以后按此”.
- Before context compaction, Rice may create a candidate from matching user-authored statements and link it to the checkpoint.
- Assistant output, hidden reasoning, web pages, connector content and tool results cannot promote themselves into durable memory.
- Promotion and correction create revisions and audit events; deletion archives the source and removes it from future recall.

## Recall policy

Automatic recall considers only durable, non-expired, tenant-authorized records. It combines vector similarity, lexical similarity, trust, confidence and freshness, then applies a relevance threshold, content deduplication, a maximum of three records and a 1,500-token budget. Unrelated memories are not injected merely because a fixed Top-K slot is available.

Explicit memory search may also return candidates so the user can inspect and confirm them. Recall updates `last_recalled_at` and `recall_count` for observability.

## Tenant and trust boundary

`allrice_memories`, revisions and RAG chunks carry organization, workspace, employee, owner and visibility scope. Authorization is applied in SQL before rows are returned. Explicit user-confirmed memory has the highest trust; derived candidates remain supporting context; external evidence is untrusted and never becomes a user preference by implication.

## User controls

The workspace Memory panel separates “待你确认” from “长期记忆” and exposes the memory class, source and revision. Owners can confirm, correct or delete their records. A candidate becomes eligible for future automatic recall only after confirmation.

## Acceptance

- an explicit “remember” survives into a different Session;
- a paraphrased but relevant request can recall the durable memory;
- an unrelated request does not receive it;
- pre-compaction capture creates an inactive candidate rather than an automatic fact;
- the owner can inspect, promote, correct and delete a memory;
- private memory never crosses user, workspace or organization boundaries;
- recall and lifecycle changes remain attributable and auditable.
