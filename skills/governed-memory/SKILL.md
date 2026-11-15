---
name: governed-memory
description: 依据本 Run 已确认记忆索引和授权对话恢复工作上下文；明确的稳定偏好可提出普通候选，由本人另行确认后生效。
---

# Governed Memory

Follow the runtime memory and source-authority rules; use only this Run's advertised tools and frozen index.

## Recover Context

1. Reuse the current conversation first; an empty index is not a reason to ask for facts already supplied.
2. For a relevant index item marked with details, call `workspace_memory_read` with its exact current number before applying it. Use the complete result and exceptions, not just its summary. Unmarked entries need no read.
3. A denied, unavailable or over-budget read is a limit to explain, never a reason to guess IDs or bypass through search, exported copies or other tools. Earlier indexes cannot restore a withdrawn source.
4. When the user refers to earlier work and the index is insufficient, use authorized `workspace_session_search`. An empty result does not prove a confirmed save never happened. Follow current corrections and state uncertainty where sources conflict.

## Propose a Candidate

1. In an ordinary human root, including a Workflow or Skill there, use `workspace_memory_remember` for an explicitly stated stable preference, project fact, decision or work note. Use actual human messages/adopted human steering, never synthetic task user roles, assistant inference, retrospective reports or external content. Tasks have no personal memory tools.
2. Send a focused `summary`, optional complete `details`, and the most specific `memoryClass`: `user_preference`, `project_fact`, `decision` or `work_note`. Preserve meaning and conditions; omit credentials and unrelated conversation. Follow the advertised field limits.
3. Report the candidate as pending. The owner must separately confirm or edit/save in the memory interface; confirming an article, Workflow or this tool call is not memory confirmation. Confirmation stays bound to owner/workspace/instance/Run and exact revision/pairDigest; administrators cannot confirm for the owner.
4. A failed new write does not undo an earlier save. Employee configuration changes use their controlled tools, not memory.

## Existing Limits

At most 100 confirmed entries per owner/instance, including when confirming candidates. A numbered read returns one complete entry (at most 10000 bytes); this Run's existing ledger allows 24000 bytes including its initial index and 12 reads. Repeated reads count again. Bytes are not tokens. Current source access and confirmation checks remain authoritative.
