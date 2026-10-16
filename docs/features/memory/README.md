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

## MET183 automatic private experience — staged delivery

Completed-task feedback is retained as immutable, private evidence associated with
its employee instance. Scheduled `experience-consolidation` is an AllRice-owned
DSH Skill inspired by Dreaming's separation of evidence and reusable drafts; it
does not install or copy an OpenClaw plugin, add a second memory database, or
change DSH compaction. Lossless integration remains deferred.

The existing automation producer creates bounded consolidation Runs. The original
feedback, sources, source/version digests, native Skill-load receipt and draft
output remain separate. An automatically generated draft is not a confirmed
preference and is excluded from recall.

PR3a adds optional **specialized validation**, reusing the existing isolated
platform-test lifecycle, Worker, model admission and route usage ledger. Existing
v1/v2 policies keep this off; a platform administrator must explicitly enable
`supported_cases` in the company experience settings. Disabling consolidation or
validation prevents new dispatch and stops in-flight validation at its next
current-authority check. Previous results remain private, read-only evidence.

The first supported case is `attendance-roster-v1`: two complete synthetic lists,
one list with an unknown attendance status, and one missing list. The original
immutable draft is supplied to native DSH in a fresh non-chat context without
business tools, source files, recalled history or external Skills. DSH's native
planning/clarification tools remain available. A server-owned assertion compares
both member identities and counts and rejects guessing missing information.
Draft routing selects a possible test, not authority to activate the draft.

One reservation is allowed per original draft. Validation is capped at five
minutes, eight per company and 64 globally per rolling day; it shares one
background execution slot with consolidation and yields to foreground jobs.
The frozen occurrence identity, model, policy, source and case digests bind the
result and subscription ledger. Cancellation, lease/timeout, current owner,
instance, model connection and content authority are checked before dispatch,
during execution and before finalization. Failed/unknown evidence is retained;
there is no implicit repeated model call.

The employee view states the exact synthetic coverage and **not enabled**.
Passing this sample does not prove the original task's roster, general business
correctness or arbitrary external Skill behavior. Unsupported drafts remain
pending. Private adoption, instance-scoped recall and chat forgetting belong to
PR3b; PR3a does not create effective memory or expose private content to company
maintainers.
