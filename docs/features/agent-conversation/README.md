# Rice conversation harness

MET-51 narrows the ordinary-user product to one entry, **与 Rice 工作**, and
keeps employee administration and SkillHub configuration outside the primary
conversation navigation.

## Runtime flow

1. Web persists the user message and a pending Rice reply.
2. The durable Worker freezes the employee provider, prompt, Skill bindings,
   tenant policy and read grants before execution.
3. A tool-enabled Rice reply runs as one ephemeral Codex app-server thread and
   one turn. Codex keeps its model/tool/model loop inside that process instead
   of restarting the CLI after every tool result.
4. Codex runs with ChatGPT subscription authentication. Shell, unified exec,
   code mode, computer use, user MCP servers and unapproved network access
   remain disabled.
5. The conversation harness exposes exactly four host-executed dynamic tools:
   `workspace.file.list`, `workspace.file.read`,
   `workspace.memory.search`, or `workspace.session.search`.
6. Every tool request is re-authorized against the frozen execution policy and
   audited. Skill installation never grants tenant data access by itself.
7. Durable RunEvents are streamed over resumable SSE and replayed after a page
   refresh. The assistant message remains the final conversation authority.

The Worker uses the Codex app-server `dynamicTools` request/response protocol.
Codex receives only JSON Schema tool definitions; when it requests a tool, the
Worker executes the existing tenant-scoped Tool Broker callback and returns the
result to the same active turn. The deployment-pinned Codex CLI version must
therefore continue to support the experimental app-server protocol. Non-tool
SkillRuns keep the narrower `codex exec --ephemeral` path.

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
