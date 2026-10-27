# P27 基础助手历史验收入口

MET-226 已删除退役供应商的 priced-native 脚本分支、价格夹具和验收步骤。原始记录保留在 Git 历史中。

`scripts/acceptance/runtime/p27-assistants.ts` 保留原有 Codex 历史夹具与预检。此入口缺少订阅证明时仍会在执行前拒绝；本次清理不改变其准入行为，也不将旧结果视为当前版本验收。

当前 Codex 订阅验收见 [P27 Codex 验收口径](./p27-codex-first-acceptance.md)，使用 `p27-codex-assistants.ts`、`p27-codex-worker.ts` 及当前平台模型配置。
