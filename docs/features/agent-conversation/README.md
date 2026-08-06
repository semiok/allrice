# Rice conversation harness

MET-51 narrows the ordinary-user product to one entry, **与 Rice 工作**, and
keeps employee administration and SkillHub configuration outside the primary
conversation navigation.

## Runtime flow

1. Web persists the user message and a pending Rice reply.
2. The durable Worker freezes the employee provider, prompt, Skill bindings,
   tenant policy and read grants before execution.
3. Each AllRice ChatSession owns one persistent Codex app-server thread. The
   Worker starts it once, stores the thread ID in PostgreSQL, and resumes it for
   later user messages instead of flattening the full transcript into every
   prompt.
4. Each Worker process reuses a long-lived app-server process for its deployment
   Codex configuration. A turn is serialized per ChatSession and guarded by a
   database run/worker lease; a Worker restart or another replica resumes the
   persisted thread.
5. Codex runs with ChatGPT subscription authentication. Shell, unified exec,
   code mode, computer use, user MCP servers and unapproved network access
   remain disabled.
6. The conversation harness exposes four tenant-data tools:
   `workspace.file.list`, `workspace.file.read`,
   `workspace.memory.search`, or `workspace.session.search`. A bound reviewed
   network Skill can additionally activate Codex Hosted Search and the guarded
   `web.fetch` reader.
7. Every tool request is re-authorized against the frozen execution policy and
   audited. Skill installation never grants tenant data access by itself.
8. Durable RunEvents are streamed over resumable SSE and replayed after a page
   refresh. The assistant message remains the final conversation authority.

The Worker uses the Codex app-server `dynamicTools` request/response protocol.
Codex receives only JSON Schema tool definitions; when it requests a tool, the
Worker executes the existing tenant-scoped Tool Broker callback and returns the
result to the same active turn. The deployment-pinned Codex CLI version must
therefore continue to support the experimental app-server protocol. Non-tool
SkillRuns keep the narrower `codex exec --ephemeral` path. A user message ID is
also sent as Codex's `clientUserMessageId`, while PostgreSQL remains the source
of truth for AllRice messages, run ownership and tenant authorization.

If the employee's model, system prompt, capabilities or installed Skill
versions change, AllRice starts a new Codex thread instead of silently resuming
one under a different security/configuration snapshot. MET-51's next runtime
increments add active-turn steering and incremental assistant deltas; this
first increment deliberately serializes a second message behind the active
turn.

## Event contract

Schema version 1 adds `assistant.text.delta`, `assistant.text.completed`,
`tool.started`, `tool.completed`, `tool.failed`, and `run.retrying`. Tool event
payloads contain a safe label, status and summary; raw credentials, local paths,
commands and file contents are never persisted as UI evidence.

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

Network access follows the SkillHub capability intersection described in the
[SkillHub guide](../skillhub/README.md). It never turns browser automation or
shell access back on, and it has no paid-provider fallback.

See the pinned [MET-51 upstream runtime review](../../audits/met-51-upstream-runtime-review.md)
for the OpenClaw, Hermes Agent and DeerFlow source comparison and copy decision.
