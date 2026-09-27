# Reply work methods

The assistant footer shows where this reply's tools actually worked, after the
native copy/feedback/time controls. Ordinary conversation has no label. These
labels describe execution location and activity, not success or authorization.

| Cloud         | Bridge        |
| ------------- | ------------- |
| 云端-计算     | Bridge-计算   |
| 云端-浏览器   | Bridge-浏览器 |
| 云端-检索     |               |
| 云端-文件     | Bridge-文件   |
| 云端-应用     | Bridge-应用   |
| 云端-定时任务 |               |

History projects the labels from existing durable records within the authorized
Session and tenant/workspace. Synchronous tools use successful `tool.completed`
records with canonical tool names. Governed asynchronous tools require an
`operation.started` ledger event and a matching frozen action/target pair.
Waiting for authorization, dispatch alone, unavailable environments, polling,
discovery and internal coordination do not count. A started operation retains
its label after failure. Older records without sufficient evidence stay unlabeled.
Cloud Office exports count as cloud files; scheduling counts as a cloud scheduled
task, while the scheduled execution's own tools are classified independently.

The mapping is an explicit allowlist in `packages/contracts/src/work-methods.ts`.
No inference comes from model prose, connected devices or configured capabilities.
The response carries only fixed enum values; no file paths, arguments or outputs
are exposed. Runtime operations rooted in the reply include delegated operations.

Labels are deduplicated in first-evidence order. At most two are shown initially;
`+N` uses the native DSH tooltip and expands on click/keyboard for desktop and
touch. The footer wraps on narrow screens. The native copy text, feedback and
visibility behavior are preserved; pinned DSH sources are unchanged.

The existing history reload after completion supplies labels in both streaming
and unified output modes, and page reload restores them. No new model calls,
polling, database tables, execution permissions or runner behavior are introduced.

Validation covers PostgreSQL evidence boundaries and tenant isolation, ordinary
chat, completion/reload in both modes at 1440px and 390px, hover, touch/keyboard
expansion, wrapping, unchanged clipboard text, and native feedback regression.
