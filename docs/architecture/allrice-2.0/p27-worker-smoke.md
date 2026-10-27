# P27 完整 Worker 连续任务验收

MET-226 已移除退役供应商的新建任务验收步骤与合成历史账务回归。原始记录保留在 Git 历史中。

当前验收入口为 `scripts/acceptance/runtime/p27-codex-worker.ts`；以服务端平台模型配置冻结每次 Run 的模型。订阅身份、Token 与月额度证据要求见 [Codex 订阅验收口径](./p27-codex-first-acceptance.md)。
