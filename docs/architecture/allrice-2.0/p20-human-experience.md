# P20 / MET-134：人工经验候选与范围审核

归属 MET-107 的 G6，按 AllRice 2.0 执行总表 B5 集成。本切片不增加 Agent Loop、自动挖掘或平台资产库。

## 用户闭环

1. ChatFlow 的「经验沉淀」进入当前工作区审核页；有当前 Session 时可以选取最近 100 条已结束任务的对话正文。
2. 人工选择原文片段、改写可复用规则、选择私密 / 当前工作区 / 平台人工转交范围。工作区共享必须明确同意共享**此条改写规则**；不共享原始私密对话。
3. 保存生成现有 Memory 的 `candidate / derived / private / revision 1`，不会生成 RAG chunk，也不会注入下一 Run。普通聊天、Ask User 答案或计划认可不是此处的审核操作。
4. 私密规则由本人明确审核；工作区规则必须由数据库中**当前有效的工作区或组织管理员**明确审核。必须附审核说明，并提交看到的版本和内容 digest。
5. 批准原子生成现有 Memory 的 `durable / user_confirmed / revision 2`、对应历史版本和 RAG chunk。继续复用既有员工范围、相关度、权限和召回预算；不承诺无关任务全部采用。
6. 后续实际新 Run 在入队时冻结被召回的 Memory ID、正文及 revision；Worker kernel 明示该 revision。批准不会修改已排队 / 运行中的 prompt snapshot。

候选和规则内容仍在 `allrice_memories`，版本仍在 `allrice_memory_revisions`。0088 只新增 `allrice_experience_reviews` 来源 / 目标范围 / 决策关联，不建立平行的 Memory、Skill 或 Artifact 内容库。

## 范围与权限

| 目标      | 候选可见性                         | 可批准者                  | 批准结果                                  |
| --------- | ---------------------------------- | ------------------------- | ----------------------------------------- |
| private   | 仅原任务本人                       | 本人（当前 member/admin） | 当前员工范围内的私密 durable Memory       |
| workspace | 本人，以及明确共享后当前有效管理员 | 当前工作区 / 组织管理员   | 当前员工范围内的 workspace durable Memory |
| platform  | 仅本人                             | 无；此 API 不支持平台批准 | 仅私密人工转交建议；不注入、不发布 Skill  |

工作区审核人只拿到改写内容和核验状态；DTO 中 `source=null`，不发送原始消息、Session/Run/Message ID 或原文片段。来源关系不放入通用共享 Memory 的 `source_id`，避免从既有 Memory API 泄漏私密会话 ID。本人可在候选卡片查看来源。

平台建议必须由人去敏，保存并不表示已经交给平台；「复制脱敏建议」只复制改写正文。现有发布工作台链接不授予新权限。平台维护者仍须走 P18 的仓库 catalog、来源/许可证/测试、员工草稿、编译/试用和发布门禁。**租户 admin 不是平台发布者，平台候选不计为已发布 Skill。** 本切片不自动检查一段文字是否绝对无敏感信息，也不自动发送到第三方。

## 来源、并发与失败边界

- 只接受本人拥有且未归档 Session 中，已结束 Employee Run 关联的 canonical user/assistant message。Run 必须有终止状态及 completed_at，消息正文 completed；不从推理、工具回显、其他用户或运行中任务取证。
- 原文片段必须属于该正文，保存完整正文的 SHA-256；批准前在事务内重新检查任务、消息、源用户和当前成员资格、源文本 digest。
- 固定来源、原任务 / 消息 ID、请求 digest、规则 digest、拟发布范围及同意标记；数据库 trigger 禁止改写这些来源字段，也禁止改写已完成审核。
- 提交使用 owner/workspace/clientRequestId 幂等键；相同请求重试返回同一候选，不同内容重用同一键返回 409。
- 决策对 review + memory 行加锁。并发批准 / 拒绝只有一个能生成 revision 2；过时版本或 digest 409，不默默覆盖。
- 当前数据库成员资格优先于浏览器缓存身份。源用户被停用、撤销成员资格或源任务被归档后，不能新增信任；来源失效后仍允许有权用户明确拒绝 / 撤回。
- 旧 Memory `correct/promote` 对 P20 管理记录拒绝直接修改，不能绕过范围审核。要修改规则，重新生成来源明确的候选并重新审核。
- 现有 owner 归档 / 删除 Memory 仍生效；取消后续召回，保留审核证据，卡片显示「已归档 · 不再召回」。历史 Run 已冻结的上下文不会被追溯重写。
- 审核候选列表最多 100 条，未处理候选优先；本切片不是全量 Session 分析或批处理管理器。
- 事务包含 Memory / revision / index / decision / 审计，失败全部回滚；错误响应不包含 SQL、密钥或原文。HTTP 写操作仅接受同源 JSON，body 上限 40 KB，响应 no-store。

## 代码落点

- `packages/contracts/src/experience.ts`：严格候选 / 审核输入、来源脱敏 DTO；旧 Run memories 新增可选 revision（兼容旧快照）。
- `packages/database/migrations/0088_experience_reviews.sql`：租户 / 工作区复合关联、幂等键、不可变来源和决策。
- `packages/database/src/experience.ts`：资格、来源、候选、事务审核和索引。
- `packages/database/src/workspace/service.ts`：复用召回 / 入队，以及旧 Memory 更新入口的绕过保护。
- `apps/worker/src/employee-kernel.ts`：实际模型输入中的已授权 Memory revision。
- `apps/web/lib/experience/http.ts`、`app/api/v1/experiences/**`：同源、认证、边界 / 错误处理。
- `apps/web/app/workspace/experience/**`：人工选取、规则改写、共享同意、审核和结果状态。

## 发布与回退

默认 `ALLRICE_EXPERIENCE_REVIEW_ENABLED=0`，UI / API 关闭。先应用 0088 expand-only 迁移并部署包含旧 Memory 绕过保护的代码，再在隔离验收环境或指定部署启用 1。无需更新 Bridge、增加系统权限或模型凭证。

接口开关关闭只停止新候选 / 审核入口，不撤销已批准的 Memory。撤销已批准规则使用现有归档操作。不要把「关 UI」误当成撤回已有知识。

回退时保留 0088 数据和旧 Memory 绕过保护；回退到完全不理解审核关联的旧二进制会使既有 `promote/correct` 重新绕过审核，故已有 P20 数据后不允许这样回退。降级读者必须保留此保护；不执行 destructive down migration。

## 验证与复现

单元 / HTTP / UI 静态渲染覆盖严格输入、显式共享、角色错误、同源、body 上限、状态和防 XSS 文本渲染。真实 PG 测试使用随机独立 schema / 合成用户，覆盖成员撤销、来源变化、跨租户 / 跨用户、幂等、竞争决策、旧接口绕过、归档、不可变来源，以及实际新 Run 和 Worker kernel。

```sh
ALLRICE_RUN_DB_INTEGRATION=1 \
ALLRICE_TEST_DATABASE_URL=postgres://a123@127.0.0.1:5432/allrice_b2 \
pnpm exec vitest run packages/database/src/experience.integration.test.ts \
  packages/contracts/src/experience.test.ts apps/web/lib/experience/http.test.ts \
  apps/web/app/workspace/experience/experience-panel.test.tsx --maxWorkers=1

pnpm --filter @allrice/contracts build
pnpm --filter @allrice/database build
pnpm --filter @allrice/web build
pnpm exec tsx scripts/acceptance/runtime/p20-human-experience.ts
```

真实 Chromium 验收在独立 3020 listener、合成密码登录和独立 schema 下验证三种范围的 UI 操作、刷新恢复、管理员私密来源不可见、实际 HTTP 401/403/404/409/400、390px 窄屏和新 Run 冻结版本。脚本只继承 allowlist 环境，拒绝 worktree 真实 dotenv，不读个人浏览器、模型密钥、Dev/Prod 或真实租户数据。证据写入独立临时目录，退出删除仅本次生成的 schema / 关闭仅本脚本启动的服务。

证据中的「下一真实 Run 使用」指实际入队记录、持久化 prompt snapshot、实际 `resolveEmployeeExecution → assembleEmployeeKernel` 所生成输入采用该规则和 revision。**没有调用计费模型、没有运行 DSH 外部进程，不把它称作模型生成最终交付的 E2E。**

本切片验收：P20 专项 41/41（含真实 PG）、Memory / Worker / UI 关联回归 32/32（与专项有重叠，不相加宣称总数）、contracts/database build、Web build、Web/Worker typecheck、修改文件 ESLint 和 diff-check 通过。最终真实 Chrome 报告 `/tmp/allrice-p20-ui-ReXsAH/report.json` 的新 Run `f6415219-a411-4c5e-a5b7-5b071408b6e9` 由真实认证 messages HTTP 返回 202 创建，包含记忆 `0a1a55ba-87b3-4e01-af73-272283a5a8d9` revision 2；旧 Run 未变、平台候选未注入。该路径为本次本机临时证据；可用上述脚本重建。报告确认 own schema 已删除，测试服务已退出。
