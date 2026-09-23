# MET-153 接管与集成路线（2026-09-23）

## 工作位置和已核实状态

- 当前工作树：`/Users/a123/allrice-met153-runtime-policy`，实际分支 `codex/met153-progress-guard`。目录名不代表当前分支。不要切换或重置有未提交修改的 `/Users/a123/allrice`。
- PR #89：`main` ← `codex/met153-runtime-policy`，`7357ca9e5a7ea114e165d2a1500c4c77545c0d5d`；核实时四项 CI 通过、无冲突。
- PR #90：`codex/met153-runtime-policy` ← `codex/met153-progress-guard`。`b39442d6ac014a35f9b52de0ad4bbfe47687301a` 已补充生产助手 controller 的非空检查及明确返回类型，四项 CI 通过。交接提示里的 `a9538a5` 报错已过时。
- 本次继续补普通聊天独立计时，详情和测试边界见 [验收记录](met153-dev-validation.md)。其后运行代码已有变化，不能继续声称 PR 最新版本与已部署 Dev `6ecf81b` 完全一致。
- Linear MET-153 仍 In Progress。真实短任务、原生合成模型、数据库租约接管与浏览器合成测试分别保留，不互相替代。

## 合并评估

`7357ca9` 已是 PR #90 HEAD 的祖先（PR #90 曾通过 `b5a07e1` 合并 PR-1 的测试修复）。核实时 `main=0bebdaa`，GitHub 允许 merge commit、squash 和 rebase。

推荐顺序：

1. 确认两个 PR 的当前 SHA、检查、验收边界及合并授权。CI 全绿和无冲突不代表 MET-153 全部验收完成。
2. PR #89 采用 **merge commit** 合入 main，并先保留分支。
3. 将 PR #90 的目标分支改为 main。由于 PR-1 原提交仍保留在 main 历史中，无需 rebase、无需强推。重新检查差异只含 PR-2 和后续收尾，等待对新目标分支的 CI。
4. 如确实选择 squash/rebase 合并 #89，则先保存 PR #90 原 HEAD 恢复引用，在独立工作树用 `git rebase --onto origin/main 7357ca9 codex/met153-progress-guard` 整理，逐项审查冲突、比较最终文件树、重新验证，再以精确远端 HEAD 的 `--force-with-lease` 更新。不能无条件 `git rebase main` 后把 PR-1 再带一遍。

本次只完成评估与 PR #90 的代码收尾，没有执行上述合并、改基线或强推动作。

## 剩余两项运行时工作

1. **长期等待的进程释放与重建**：`DshRuntimePool` 目前持有内存中的 client/session；`allrice-jsonrpc-runtime.mjs` 的原生问题包含进程内 Promise，而 `runNativeTurn` 等待原生 idle。仅调用 `drop()` 会关闭进程，不构成可恢复挂起。应先定义持久化等待描述和可重建边界，确认所有主/子调用及命令已停，保存原 Run/时钟/问题或审批身份，再有序退出并在新租约下恢复。并行活跃参与者及结果未知的已派发动作不能进入该路径。
2. **完整 Worker/原生进程中断验收**：原生 `createSession()` 已尝试从持久会话恢复，但这并不恢复任意进程内 RPC。需要通过真实 Worker 子进程的停止/重启、新租约 claim、原生重建和实际入口回答形成完整回归。覆盖问题等待、动作审批、旧租约 fencing、重复恢复、过期审批、撤权、候选变化与未知执行拒绝重放；检查原 Run 的 active/waiting 累计与统计都不重置。先用隔离 PostgreSQL 和合成 HTTP 模型验证生产路径，再做获准 Dev/Snow 场景。

普通聊天新增展示还需固定新候选的 Dev 浏览器复验。完成前保持工单进行中；本次范围不含 Prod、MET-145 Boost、MET-146 Teamwork 或 Apple 签名。
