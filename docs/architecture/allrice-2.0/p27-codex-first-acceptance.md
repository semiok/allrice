# P27：Codex 订阅优先验收

2026-09-15，按用户最新决定：**当前只开发、验证 Codex 订阅模式；Gemini 和其他 API 模式不作为本批验收前置，以后另行扩展。** 保留历史失败收据、既有 API 代码与配置，不将其删除或改写为成功。

12:22 后续：139/140 的失败、取消、隔离与增量迁移本地验收已补齐，当前进入待交付审查；
142 完整 RC/发布矩阵仍未完成。见 [本次收尾证据与剩余门禁](b6-subscription-closeout-20260915.md)。
下文 11:28 真实模型结果的源码、Token 和原始报告保持不变，没有用新脚本倒填旧证明。

## 2026-09-15：订阅主链联验通过（尚未部署）

本轮已开始运行代码开发，不再仅调整口径。当前候选增加严格冻结的订阅身份与不可变 `0097_route_subscription_snapshots` 证明：仅经服务端校验的路由才使用金额 N/A；历史 NULL 不被追认，未知 Token 继续阻断。普通任务和助手均接入订阅准入，实际用量由原生回执投影，不因回答成功而补造完整用量。

`0098_codex_subscription_quota` 保存同一 AllRice 授权账号的官方额度快照。显式配置 `ALLRICE_CODEX_QUOTA_COMMAND` 为受信任的绝对 Codex **原生可执行文件** 路径后，现有 Worker provider probe 才启用只读查询；缺失配置显示未知，不寻找或借用桌面账号。查询只运行官方 app-server 的账号 RPC，不启动线程/任务；凭据只由原有 DSH credential service 交给私有 stdin，在独立临时 home 内使用 ephemeral 存储，退出后清理。不要配置 npm 的 JS shim（隔离 PATH 不提供 Node 查找）。

后台区分订阅额度与平台内部月度限制；账号查询失败/窗口过期显示未知，明确耗尽时阻止新模型派发，不宣称已经停止远端在途计量。平台不自动购买额度、不切换 API、不改真实租户开关。

2026-09-15 11:26:36（北京时间），同一 AllRice 绑定账号的真实只读查询成功：`codex` bucket 的 10080 分钟周窗口已用 **73%、剩余 27%**，重置时间为 Unix `1789829581`（北京时间 2026-09-19 22:53:01）；未返回的 secondary 窗口保持未知，不能拼出一个不存在的五小时余额。查询没有模型调用，临时目录已清理。10:43:12 的旧快照为已用 70%、剩余 30%；共享账号变化不能全部归因于本次测试。最新只读收据 `.local/p27-codex-quota-3763c4d4-fae0-4223-8410-93e0a6911fa8.json`，SHA-256 `2cf76f00b27841bd2da6187c0e8fb8bc45f53eace254a967a6cb11a0e7892461`。

首次额度兼容失败是官方 CLI 启动时发送 `remoteControl/status/changed`；以原生 CLI 导出的 schema 和 method SHA-256 比对定位后，仅允许无 id 且 `status=disabled` 的通知，其他远程控制状态仍拒绝，没有开启远程控制。

### 真实双助手 → 普通 Worker → 同源页面：通过

干净源码 `68571d467919daa443b477d43192884664749d8f`，Next BUILD_ID `gsp7PhpPt4QdFLnwTJIOL`，固定 DSH `0.1.1-rc.2` / pi-ai `0.82.1`。11:27:36～11:28:18（北京时间）在隔离 PostgreSQL 随机 schema、私有存储中，通过原有 DSH 订阅鉴权完成两条真实生产 Worker 任务，禁 API fallback、禁自动重放；不是直接模型替身或只查旧数据库。

- 第一个根 Run `443a6f5c-1320-4ca8-a228-102d4d476f4d` 与两个助手均 completed。5 次助手树模型准入全部 dispatched/finished，输入 6158、输出 782 Token；两个不可变工件、父级持久采纳和汇总一致，报告 A 合计 875 / 2 行，报告 B 未付 600，父级确认收到 2 份报告。
- 只有第一条任务的双账本、工件、消息与平台内部配额检查全部通过后，才创建下一条普通 Run `d0256811-3e84-4704-ad62-656d86836242`；普通任务正确返回 579，输入 1159、输出 26 Token，无助手树或工具调用，两条 Worker 均 succeeded。普通任务使用同一隔离夹具的另一 Session，不是同会话多轮上下文连续性验收；本报告未再次查询上游订阅余额，真实余额来自前述独立只读收据。
- 合计真实用量 **8125 Token**，持久配额聚合 `subscriptionRuns=2`、`unknownCostRuns=0`。每条受信订阅 route/ledger 的货币项是 NULL + 不可变订阅证明，对应 **N/A**；聚合 API 计费小计 0 不能解释为订阅免费。缓存拆分仍标记未知，不用 0 伪造已知缓存明细；总 Token 用量已完整投影。
- 随后的真实 Chrome + 同候选 built Next 读取上述同一 Session、Run、消息及工件字节；仅临时登录身份为测试夹具，没有合成助手结果。桌面/390px 可见两个完成助手，父级采纳、关联工件接口 200 且内容摘要一致；下一普通会话显示 579，不残留上一助手树。完成后停止按钮禁用，业务完成记录未被页面改写，Page/Console/HTTP 错误均为 0。主开发实际查看三张截图。
- 本次拥有的 Native 2/2 已退出；执行、心跳、Chrome、Next、随机 schema、存储、数据库连接与私有临时目录均确认清理。没有调用 Gemini/API、改真实租户开关、push、新建 PR、合 main 或部署 Dev/Prod。

主收据 `.local/p27-codex-assistants-3c12900a-ee32-411a-a0c4-2131c53ede20/result.json`，SHA-256 `81f99e32a3c55065aee4e29c2f30af21261df43616754c1755b710d8f86d303c`。同目录 `worker-ui/worker-ui-checks.json`，SHA-256 `8fffb17c3b611e8b6bdb3761c4370a2bd8fee5748121476af4a41ef49501aaaa`；截图为 `worker-ui-assistant-desktop.png`、`worker-ui-assistant-narrow.png`、`worker-ui-ordinary-desktop.png`。

### 配套回归与证据边界

- 全仓常规回归 **2441 passed / 0 failed / 868 skipped**，报告 `.local/b6-subscription-final-regression-20260915.json`，SHA-256 `8eb38910dcbf1c52e9bbfa4eb693cc3d9a142827e01e0721bfb1f3f2b34c2257`。它覆盖本轮产品改动，但运行早于最后的验收 helper 修正；跳过项不是通过，不作为固定候选全矩阵。
- `36a8972` 的额度持久化、Broker/准入、工件与 UI guard 定向真实 PG 等回归 **43/43，0 skipped**，报告 `.local/b6-subscription-final-db-36a8972.json`，SHA-256 `6cf311d871d93d0414f9c2cef76ed2bf568bd832c6701bee113e4cfbdd70dc4e`。其他独立/重叠定向测试不累计为唯一总数。全仓 typecheck/lint/format、固定 DSH 检查通过，`68571d4` 完整构建通过。
- 最终 `68571d4` 的额度页面用真实 PG/API/Chrome 验证 **8/8 合成边界场景**：周窗口、动态 90 分钟窗口、耗尽、查询失败、陈旧、重置已过、缺失、390px；22 处计算文字对比度最低 4.98。证据 `/tmp/allrice-p28-quota-ui-FxALxc/evidence/checks.json`，SHA-256 `a29a462612301eabd779e4f4e1b859cc6646f00328a96da407af9e5bf85806c4`。页面数据是明确的合成额度，不是上述真实账号 73% 快照；无模型调用、页面/接口错误或外部请求，资源已清理。
- `36a8972` 的既有 P26 历史页面回归也通过：合成失败/取消历史、刷新、会话隔离、flag OFF 历史读取、Codex 助手启用、用户不使用助手偏好与冻结配置保持。证据 `/tmp/allrice-p26-ui-jvlTRn/evidence/checks.json`，SHA-256 `f34fe7e6cf9f9bb076ecffd657e6a2c437d35cc341cc4c32dcdec0817082cacd`；无真实 Worker/provider，不能替代上面的真实双助手链。

额度 UI 首版虽通过 DOM/API 断言，截图暴露文字对比不足，已修复；`36a8972` 的首次完整对比度测试又因验收脚本序列化出现 `ReferenceError: __name is not defined`，不算通过，失败证据 `/tmp/allrice-p28-quota-ui-TAz1Gf/evidence/checks.json`（SHA-256 `b05613791eef6466ee5d5e3e89d8995cf79be5e4eeae3882591f70817731fbc9`）保留。`68571d4` 仅修复浏览器原生 evaluator 序列化，随后整组 8/8 通过；没有通过关闭错误检测或放宽产品策略获得成功。

**已补齐的是 Codex 订阅正向主链，不是 MET-139/140/142 全部 Done 或 B6/RC/GA 完成。** 还需按最终候选补齐完整失败/取消与联合矩阵、PR/CI 和 Dev 验收；MET-143 正式 Apple 签名、公证和可信包实测继续独立保留。后续文档提交不改变上述被测源码 SHA，也不冒称重跑模型。

### 首个订阅双助手候选：运行完成，验收解析失败（历史保留）

干净候选 `f9574071f3ca9bfb59ea3a1188c94f522b9e68c3` 于 10:48:24～10:48:47（北京时间）只执行了第一条真实 Worker：父任务和两个助手在数据库中均 completed，5 次模型准入已派发并完成，全树输入 6276 / 输出 744 Token，route 与 usage ledger 均成功且金额 NULL（有冻结订阅证明，对应 N/A，不是免费）。但是后续验收在 `assistant_ledger_verify` 阶段出现 SyntaxError，故收据仍为 **failed**，没有准备或执行下一普通任务，也不能计作完整链路通过。

原失败未记录具体 JSON 层级，现场已按隔离规则清理，不能追认是子报告还是父回答的格式导致。后续为模型拥有的 JSON 文本增加严格的纯 JSON / 单完整 JSON 围栏解析，并拒绝说明文字、重复键和多段内容；服务器产物封装仍只接受原始 JSON。失败只保留固定阶段、长度、摘要与格式标记，不保存模型原文或原生 SyntaxError 内容。新增生产 `publishAssistantOutput` → 隔离 PG → 不可变产物读取回归，不能仅用合成字符串测试替代。

失败收据：`.local/p27-codex-assistants-6a512ff4-4f0b-4ef0-818a-1ebcb3c51a78/result.json`，SHA-256 `6fa5880303d7bb6505569253d349e7791ec95bd70dbf8e08c900b44db897bc4b`。Native 1/1、执行/心跳、随机 schema、存储、连接与本次临时目录全部确认清理；不自动重放原任务。10:47:43 同候选额度只读收据 SHA-256 `842d5ae8a6ca125ef2cbcffabe48509dc0bf8592b6a344d467ba6907d60b9863`，路径 `.local/p27-codex-quota-28418b07-a42e-4e5f-8e0f-ce3bf7d4c02c.json`。

## 历史订阅口径（实现前核对记录，以顶部实测进展为准）

此前把 API 单价与请求级 `max_output_tokens` 硬上限作为 Codex 助手的产品前提不合适。本次调整该前提，不再等待用户确认 API 预算方案；历史参数拒绝证据仍然有效，但不能由此推导订阅助手不可实现。

OpenAI 官方说明订阅存在五小时用量窗口，周限制也可能适用；实际额度及重置时间以绑定账号的用量面板为准，不能按固定消息条数或 Token 数折算。达到额度时，在途 turn 仍可能继续，因此周额度不是单请求输出硬上限。[官方订阅用量说明](https://learn.chatgpt.com/docs/pricing)

官方 Codex app-server 提供 `account/rateLimits/read` 和 `account/rateLimits/updated`，返回用量比例、窗口时长及重置时间，支持多个 limit bucket；它是不同于当前 DSH 的协议，不能直接把该 RPC 发给 DSH 就声称已经接入。[官方 app-server 文档](https://learn.chatgpt.com/docs/app-server)

实现前源码核对结果：当时 `provider/status` 仅返回凭据是否配置、可写及类型，管理员接口没有额度或订阅账号身份。AllRice 实际绑定 `ALLRICE_DSH_PLATFORM_HOME/.credentials.yaml`，不能用桌面 Codex 登录的额度替代。该次文档核对未查询到绑定账号的实际剩余百分比，也没有发起模型请求；本轮实现进展见上文。

MET-139 后续实现按以下口径推进，再进入 MET-140 → MET-142：

- 订阅额度与平台内部限制分开。适配查询时必须绑定同一授权账号，最小化保存账号绑定标识、limitId、usedPercent、windowDurationMins、resetsAt、checkedAt 与查询状态；账号切换使旧快照失效，不硬编码 primary/secondary 的窗口含义。缺失或过期显示未知，不能显示成零或无限；不读取其他账号替代。
- 按订阅账号共享额度处理新调用派发与助手并发，不能给多个租户各自虚构一份完整周额度。耗尽后暂停新派发并显示重置时间，不自动购买额度、消耗重置券、切到付费 API 或反复重试；在途任务按实际完成/取消回执收束，未知结果不重放。
- 使用明确的订阅计量口径：真实 Token、模型/工具调用次数、并发、深度、时长与取消控制；调用/并发等本地强制限制和 Token 软阈值分别标注。超时断流不能冒充上游已停止计量，也不承诺周额度保证单次调用的硬上限。
- 订阅单次 API 估算费用为“不适用”，不是免费、已知零或费用未知；本批不要求 API 单价表及逐笔 API 金额对账。只对可信冻结的订阅路由调整货币准入，不放开未知 Token、租户隔离、租约、撤权和重复执行保护，也不改写历史账本。
- 助手旧门禁需要用订阅适用的准入和回归替换，不是直接删掉检查上线。先完成离线/隔离 PG 的额度耗尽、未知/过期、账号切换、并发竞争、取消和账务不适用测试，再执行有界真实双助手及后续普通任务，最终补 UI 联验。

以上是已确定的当前实施范围，**不是运行代码已完成或正式能力已开放的声明**。不启动新的三栏优化，Bridge 正式签名仍是 MET-143 独立待办。

## 2026-09-14 既有验收边界（历史）

先验证既有 Codex 订阅普通 Worker 路径，再验证助手所依赖的输出上限。普通任务成功不能代替 MET-139 双助手、MET-140 真实 UI 联验或 MET-142 最终矩阵。

- 使用隔离本地候选、明确 SHA、专用 `allrice_b2` 的随机 schema；不修改 Dev/Prod 或现有租户开关。
- 普通 Worker 只准备并执行一个短算术任务；冻结 `allowAssistants=false`、空工具列表、禁 fallback、job `maxAttempts=1`。应用超时不等于服务端停止或订阅额度的硬上限。
- 凭据仅由现有 DSH 订阅服务使用；验收 driver 只验证授权 Dev home 的路径和文件元数据，不复制、打印或自行解析凭据文件。
- 单独的 cap probe 不注册 Agent，不执行工具；在固定订阅端点测试 `max_output_tokens`，不自动去掉参数重试。不因一次响应或本地 loopback 就打开生产助手门禁。
- 不增加 Gemini 审核门禁。Bridge 正式签名仍是 MET-143 独立外部待办。

## 2026-09-14 已确认的实现差异（历史）

固定 DSH 会向 pi-ai 传递 `maxTokens`，但固定 `pi-ai 0.82.1` 的 Codex 请求体不序列化输出上限。DSH 的请求对象也不透传 pi-ai 的 `onPayload`；仅增加该字段并不能修复实际传输。本地协议回归使用真实固定 SDK 和 loopback HTTP，证明的是这些序列化行为，不能证明远端订阅接口支持公开 Responses API 的同名参数。

OpenAI 官方区分 ChatGPT 订阅认证与按量 API key 认证。因此订阅调用不能按 API 单价解释，也不能把没有 API 报价时旧估算器返回的 `0` 当成“订阅免费”。[官方认证说明](https://learn.chatgpt.com/docs/auth)

当前普通 Worker 的旧估算器缺价返回 `0`；本轮普通链路报告必须明确标出这一限制，不作为订阅账务正确性的证明。后续订阅计量应保留真实 Token/调用次数，并明确区分“费用不适用”与“用量未知”；不得解除 API unknown、未知 Token、取消、租约和重复执行保护来获得通过结果。

## 2026-09-14 证据分层（历史）

| 证据                       | 能证明                                                   | 不能证明                               |
| -------------------------- | -------------------------------------------------------- | -------------------------------------- |
| 隔离 PG / 合成 native 回归 | 权限、账务、取消、失败路径的实现行为                     | 真实模型成功                           |
| Codex wire loopback        | 固定 SDK 实际序列化及参数拒绝后的行为                    | 订阅后端支持或强制输出上限             |
| Codex 普通完整 Worker      | 实际订阅鉴权、模型结果、事件/Run/双账本持久化及清理      | 双助手、账单金额、全部 UI/设备验收     |
| 订阅 cap probe             | 该次请求的 HTTP 状态、参数拒绝/接收、finish 与已报告用量 | 任意任务的硬预算保证或自动开放助手权限 |

## 2026-09-14 真实结果（历史，非当前候选）

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
