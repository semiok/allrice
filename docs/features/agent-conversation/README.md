# Rice conversation runtime

MET-51 narrows the ordinary-user product to one entry, **与 Rice 工作**, and
keeps employee administration and DSH-native Skill configuration outside the primary
conversation navigation.

## Runtime flow

1. Web persists the user message and a pending Rice reply.
2. The durable Worker freezes the employee provider, prompt, Skill bindings,
   tenant policy and read grants before execution.
3. Each AllRice ChatSession owns one persistent DSH session. The Worker stores
   the DSH session identity in PostgreSQL and resumes it for later user messages
   instead of flattening the full transcript into every prompt.
4. A turn is serialized per ChatSession and guarded by a database Run/Worker
   lease; a Worker restart or another replica recovers the DSH session from its
   tenant-scoped persistence root.
5. DSH selects the frozen Provider route. Codex subscription is
   `openai-codex` inside DSH; MiniMax and other managed APIs use DSH Provider
   plugins. Shell, filesystem, browser, MCP, subagent and unapproved network
   capabilities remain disabled.
6. The conversation harness exposes four tenant-data tools:
   `workspace.file.list`, `workspace.file.read`,
   `workspace.memory.search`, or `workspace.session.search`. A bound reviewed
   network Skill can additionally activate `web.search` through the deployment
   Codex subscription and the guarded `web.fetch` page reader. The reviewed
   `wechat-research` Skill uses cloud-only `wechat.article.search` and
   `wechat.article.read` native Tools; it does not require Rice Bridge.
7. Every tool request is re-authorized against the frozen execution policy and
   audited. A Skill definition never grants tenant data access by itself.
8. DSH assistant deltas are normalized by the HarnessAdapter, batched by an
   80 ms / 512 character Worker window, persisted as ordered RunEvents and
   streamed over resumable SSE. Refresh and reconnect replay the same event IDs;
   the completed assistant message remains the final conversation authority.

The Worker freezes approved native tool grants into the tenant-isolated DSH
process. `web.search`, the two cloud WeChat article Tools and the five Rice Bridge capabilities (`local.fs.list`,
`local.fs.search`, `local.fs.read`, `local.git.status`, `local.git.diff`) use
DSH's native tool protocol and complete within one DSH Turn. Broker-backed native calls
travel back over bidirectional JSON-RPC to the active AllRice Tool Broker,
which re-authorizes the frozen Run policy and audits the call. Local Tools then
dispatch only the corresponding structured read-only Bridge command; WeChat
Tools remain in the SaaS cloud service. Their safe call/result
events are still persisted and audited by ChatFlow. Tools without a native
adapter continue through the tenant-scoped Tool Broker compatibility bridge. Skills are
immutable capability context bound to an employee; standalone Skill execution
is retired because it would create a second execution authority. PostgreSQL
remains the source of truth for messages, Run ownership and authorization.

If the employee's model, system prompt, capabilities or installed Skill
versions change, AllRice starts a new DSH session instead of silently resuming
one under a different security/configuration snapshot. MET-51's next runtime
increments add context compaction and active-turn steering. A second message is
still deliberately serialized behind the active turn.

Long conversations are compacted only after a turn and its tool lifecycle have
closed. The threshold measures growth above the thread generation's first
observed provider input, excluding fixed system, Harness and tool-schema
overhead. AllRice compares that growth with its tenant-authorized visible
conversation estimate and uses the larger value. Cached input is retained for
diagnostics but is not itself treated as conversation growth. When this dynamic
context reaches the configured token threshold,
AllRice asks the active Harness to compact its thread, then stores a tenant-bound
`ContextCheckpoint` with an extractive summary, covered message ID, summary
version, configuration checksum, token estimate and thread generation. A
checkpoint with a mismatched checksum is ignored. If DSH can no longer resume
the old session, the new generation starts from the verified checkpoint plus the
uncovered recent message window. `ALLRICE_CONTEXT_COMPACT_TOKENS` defaults to
40,000. The watermark resets after compaction or a new thread generation and
may be lowered in deterministic acceptance tests.

## Event contract

Schema version 1 adds `assistant.text.delta`, `assistant.text.completed`,
`tool.started`, `tool.completed`, `tool.failed`, and `run.retrying`. Tool event
payloads contain a safe label, status and summary; raw credentials, local paths,
commands and file contents are never persisted as UI evidence.

Assistant events carry generation, turn, attempt, message and adapter-local
order metadata. The Web client renders only the newest generation/attempt,
deduplicates replayed event IDs, and uses `assistant.text.completed` to calibrate
the accumulated delta text. Only visible assistant deltas are forwarded; hidden
reasoning is neither persisted nor displayed.

The UI groups tool events by `toolCallId` in a collapsed disclosure under the
Rice reply. Failed and canceled runs remain visible and the stream can be
resumed using the last SSE event ID.

## File boundaries

Users can attach an already-authorized workspace file or upload a local file.
Local uploads are explicitly `private` or `workspace` visible. Conversation
file reads currently support `text/plain`, `text/markdown`, and
`application/json`, with a 200 KB read limit.

Arbitrary shell execution and per-tenant sandboxes are deliberately deferred;
they require a separate sandbox runner and approval model rather than an
expansion of the conversation Tool Broker.

Network access follows the frozen employee Tool grants. It never turns browser
automation or shell access back on, and it has no paid-provider fallback.

See the pinned [MET-51 upstream runtime review](../../audits/met-51-upstream-runtime-review.md)
for the OpenClaw, Hermes Agent and DeerFlow source comparison and copy decision.
