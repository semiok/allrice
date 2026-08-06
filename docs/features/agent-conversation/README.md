# Rice conversation harness

MET-51 narrows the ordinary-user product to one entry, **与 Rice 工作**, and
keeps employee administration and SkillHub configuration outside the primary
conversation navigation.

## Runtime flow

1. Web persists the user message and a pending Rice reply.
2. The durable Worker freezes the employee provider, prompt, Skill bindings,
   tenant policy and read grants before execution.
3. Codex runs with ChatGPT subscription authentication. Shell, unified exec,
   code mode, computer use and unapproved network access remain disabled.
4. The conversation harness may request one of four Tool Broker operations:
   `workspace.file.list`, `workspace.file.read`,
   `workspace.memory.search`, or `workspace.session.search`.
5. Every tool request is re-authorized against the frozen execution policy and
   audited. Skill installation never grants tenant data access by itself.
6. Durable RunEvents are streamed over resumable SSE and replayed after a page
   refresh. The assistant message remains the final conversation authority.

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
