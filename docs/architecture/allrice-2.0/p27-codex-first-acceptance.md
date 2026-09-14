# P27：Codex 订阅优先验收

2026-09-14，按用户最新决定：暂停 Gemini 的模型请求与故障排查，待用户提供 Gemini 反馈后再处理。保留历史失败收据，不将其改写为成功，也不把可能的每日配额当成已证实原因。

## 本轮边界

先验证既有 Codex 订阅普通 Worker 路径，再验证助手所依赖的输出上限。普通任务成功不能代替 MET-139 双助手、MET-140 真实 UI 联验或 MET-142 最终矩阵。

- 使用隔离本地候选、明确 SHA、专用 `allrice_b2` 的随机 schema；不修改 Dev/Prod 或现有租户开关。
- 普通 Worker 只准备并执行一个短算术任务；冻结 `allowAssistants=false`、空工具列表、禁 fallback、job `maxAttempts=1`。应用超时不等于服务端停止或订阅额度的硬上限。
- 凭据仅由现有 DSH 订阅服务使用；验收 driver 只验证授权 Dev home 的路径和文件元数据，不复制、打印或自行解析凭据文件。
- 单独的 cap probe 不注册 Agent，不执行工具；在固定订阅端点测试 `max_output_tokens`，不自动去掉参数重试。不因一次响应或本地 loopback 就打开生产助手门禁。
- 不增加 Gemini 审核门禁。Bridge 正式签名仍是 MET-143 独立外部待办。

## 已确认的实现差异

固定 DSH 会向 pi-ai 传递 `maxTokens`，但固定 `pi-ai 0.82.1` 的 Codex 请求体不序列化输出上限。DSH 的请求对象也不透传 pi-ai 的 `onPayload`；仅增加该字段并不能修复实际传输。本地协议回归使用真实固定 SDK 和 loopback HTTP，证明的是这些序列化行为，不能证明远端订阅接口支持公开 Responses API 的同名参数。

OpenAI 官方区分 ChatGPT 订阅认证与按量 API key 认证。因此订阅调用不能按 API 单价解释，也不能把没有 API 报价时旧估算器返回的 `0` 当成“订阅免费”。[官方认证说明](https://learn.chatgpt.com/docs/auth)

当前普通 Worker 的旧估算器缺价返回 `0`；本轮普通链路报告必须明确标出这一限制，不作为订阅账务正确性的证明。后续订阅计量应保留真实 Token/调用次数，并明确区分“费用不适用”与“用量未知”；不得解除 API unknown、未知 Token、取消、租约和重复执行保护来获得通过结果。

## 证据分层

| 证据                       | 能证明                                                   | 不能证明                               |
| -------------------------- | -------------------------------------------------------- | -------------------------------------- |
| 隔离 PG / 合成 native 回归 | 权限、账务、取消、失败路径的实现行为                     | 真实模型成功                           |
| Codex wire loopback        | 固定 SDK 实际序列化及参数拒绝后的行为                    | 订阅后端支持或强制输出上限             |
| Codex 普通完整 Worker      | 实际订阅鉴权、模型结果、事件/Run/双账本持久化及清理      | 双助手、账单金额、全部 UI/设备验收     |
| 订阅 cap probe             | 该次请求的 HTTP 状态、参数拒绝/接收、finish 与已报告用量 | 任意任务的硬预算保证或自动开放助手权限 |

## 本轮真实结果

候选 `ba36d9c467bb6757cfea2700dc69136ace30d23d`，执行前后工作树干净；固定 DSH `0.1.1-rc.2` / pi-ai `0.82.1`。未修改依赖、生产能力门禁、Dev/Prod 或真实租户设置。

### Codex 普通 Worker：通过

2026-09-14 23:43:25～23:43:35（Asia/Shanghai），只执行一个真实生产 `executeEmployeeRun`，走正常 DSH 订阅鉴权，使用 `openai-codex / gpt-5.6-luna / low`。模型正确返回算术结果，真实 Run/job 成功，route/usage ledger 双表与模型结果一致：输入 1157、输出 9、缓存 0，共 1166 Token。只有一个普通 Run，无助手树、工具事件或 fallback。

测试 Native host 1/1 退出，execution/heartbeat、schema、存储、数据库连接和临时目录均确认清理。证据：`.local/p27-codex-worker-ba1165eb-42dd-42f0-afcc-90e1b4dc3a04/result.json`，SHA-256 `34f1ab5d1fa53435f511d02f2c3b70f921057c574d2d745fe89ab037f7d7323c`。

该次旧估算器/账本金额确为 `0.000000`，报告明确 `accountingCorrectnessProven=false`，不解释为订阅免费或真实账单。没有调用助手，因此也不是“双助手完成后下一普通任务”的联验。

### 订阅输出上限：远端明确拒绝

同一干净候选于 23:44 执行一次独立 probe。固定订阅端点返回 **HTTP 400**，错误经白名单分类为 **不支持 `max_output_tokens`**；payloadCount=1，SSE、SDK maxRetries=0，没有移除该字段重试。usage 没有返回，保留 `null`，不声称已知零消耗。

报告状态 `diagnosed_cap_field_rejected` 表示已取得兼容性结论，**不是功能通过**；`assistantReady=false`，`serverEnforcementProven=false`。只读 native host 已退出，临时目录已清理。证据：`.local/p27-codex-cap-probe-23da9142-2b8f-440e-a342-853314235127/report.json`，SHA-256 `17bc6e462b63c244e3c2cbd4f47169433ffa6bcb41ba73497c3f717a5718164a`。

所以这里不只是 SDK 漏传字段：本次实际订阅端点也拒绝该字段。不能把公开 Responses API 的输出上限适配直接用于此路径；也不能由此断言 Codex 产品永远不支持助手。新的订阅预算策略需区分可强制的调用/并发/深度/时间限制、实际 Token 计量与未验证的服务端硬上限，并完成专门验收后再决定开放；不能把软阈值改名成硬上限。

### 回归与剩余项

- 候选新增验收/诊断用例 **81 passed / 0 failed / 0 skipped**（5 文件，含真实隔离 PG、真实固定 SDK loopback、只读 native host）。报告 `.local/b6-codex-new-ba36d9c.json`，SHA-256 `1b0bf4426941f508da1806c7cfd878b1bb35471d5cfdb75a84ce490c10fdfe4d`。这些用例没有调用真实模型。
- 原关键回归独立复跑 113/113，账务未知/重放/准入保护另 40/40；与新增用例有文件重叠，不相加宣称唯一用例总数。
- P27 TypeScript 零诊断，新增文件 ESLint/Prettier 和 `dsh:verify` 通过；未重跑最终全仓/双机/真实 UI 矩阵。
- MET-139 仍缺订阅适用的预算和计量方案及真实双助手成功；MET-140/142 对应联验仍未完成。Gemini 排查暂停，等待用户反馈，不能把它作为继续 Codex 工作的等待理由。
