# MET-153 接管与集成路线（2026-09-23）

## 工作位置和已核实状态

- 当前工作树：`/Users/a123/allrice-met153-runtime-policy`，实际分支 `codex/met153-progress-guard`。目录名不代表当前分支。不要切换或重置有未提交修改的 `/Users/a123/allrice`。
- PR #89：`main` ← `codex/met153-runtime-policy`，`7357ca9e5a7ea114e165d2a1500c4c77545c0d5d`；核实时四项 CI 通过、无冲突。
- PR #90：`codex/met153-runtime-policy` ← `codex/met153-progress-guard`。原 controller 类型错误早已由 `b39442d` 修复；接管后补持久提问、进程丢失保护、普通计时及真实验收发现的投影修正。
- 当前 Dev 固定运行 `10bda7c662edb824502b781c04d280c37d6add48`。普通页面、后台、长期提问释放及真实 Worker 重启恢复已完成验收，最新 Run 为 `c1f509a1`，详情见 [验收记录](met153-dev-validation.md)。后续仅文档提交不代表重新部署。
- 工单关单依据已归档，状态以 Linear 实时记录为准。真实任务、原生合成模型、数据库租约接管与浏览器合成测试分别保留，不互相替代。

## 合并评估

`7357ca9` 已是 PR #90 HEAD 的祖先（PR #90 曾通过 `b5a07e1` 合并 PR-1 的测试修复）。核实时 `main=0bebdaa`，GitHub 允许 merge commit、squash 和 rebase。

推荐顺序：

1. 确认两个 PR 的当前 SHA、检查、验收边界及合并授权。CI 全绿和无冲突不代表 MET-153 全部验收完成。
2. PR #89 采用 **merge commit** 合入 main，并先保留分支。
3. 将 PR #90 的目标分支改为 main。由于 PR-1 原提交仍保留在 main 历史中，无需 rebase、无需强推。重新检查差异只含 PR-2 和后续收尾，等待对新目标分支的 CI。
4. 如确实选择 squash/rebase 合并 #89，则先保存 PR #90 原 HEAD 恢复引用，在独立工作树用 `git rebase --onto origin/main 7357ca9 codex/met153-progress-guard` 整理，逐项审查冲突、比较最终文件树、重新验证，再以精确远端 HEAD 的 `--force-with-lease` 更新。不能无条件 `git rebase main` 后把 PR-1 再带一遍。

本次只完成评估与 PR #90 的代码收尾，没有执行上述合并、改基线或强推动作。

## 本次补充的恢复边界

普通 DSH 任务的原生提问与无进展提问，在等待 30 秒且没有其他活跃原生参与者时，先写原生 journal 检查点、排空提问回调，再持久化为队列等待并释放原生进程、任务 heartbeat 和本轮等待定时器。0105 保存问题、会话、原 turn、配置和 generation，回答仍使用现有认证入口及原生采纳证明。新 Worker 续接同一个 Allrice Run 的原生会话，新建一个原生 continuation turn；不再次发送原任务提示词。

这是明确的静止边界，不能序列化任意 JavaScript 回调。助手树、未结束模型/工具调用、尚未完成或结果未知的运行时动作均禁止走提问释放路径；持久化工作流审批继续使用原有 workflow 恢复机制。新的 dispatch 标记使普通任务在活跃进程丢失后保留未知结果并终止，禁止以重发任务来假装恢复。

独立 Worker 子进程 + 真实 PostgreSQL + 原生 DSH + 合成 HTTP 模型已覆盖等待后杀 Worker、新 Worker claim、原问题回答、同 Run 完成、40 分钟等待不耗活跃预算；活跃时强杀则不产生第二次模型请求。数据库回归覆盖撤权、配置变化、旧租约、无效回答、重复恢复和取消。该 Worker fixture 调用生产 queue/job-runner/adapter，使用精简 handler；完整 `executeEmployeeRun` 和真实 Codex 的证据由最终 `10bda7c` 的 Dev/Snow 正式入口验收补齐。

## 回退与合并交付

0105 是兼容扩展，不删除历史时钟或账本。旧运行时代码回退必须同时保留 0105 迁移清单，并识别原生 journal 的 `allrice/wait/checkpoint`、`allrice/wait/continued` 两种私有事件；原 `731f836` 不具备该词汇，不能直接作为新候选的回退版。旧版不能接管已挂起的新式问题，切换前须确认 Dev 没有活动或挂起任务。新候选/兼容回退版需实际构建并启动验证。

最终 Dev 浏览器复验已通过：任务活跃 11,515 ms、等待 46,312 ms、2 次模型请求及 1 次工具调用，等待重启未重置时钟，原 Run 成功。Dev 没有遗留活动任务，权限、原额度与 Prod 未改。代码及 Dev 验收完成后的集成仍按上面的 #89 → #90 路线；本次没有执行合并或改 base，不含 Prod、MET-145 Boost、MET-146 Teamwork 或 Apple 签名。
