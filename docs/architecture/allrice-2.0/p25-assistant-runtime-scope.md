# P25：基础助手的实现范围、恢复策略与验收地图

MET-108 A～D / B6 / S6。最后审阅日期：2026-09-14。
本页是实现与独立安全读审的范围说明，不是 P25、P27、B6 或 GA 的通过证明。
不授权部署、迁移、租户启用、签名发包或生产变更。

## 状态与证据边界

P25 把固定 DSH 原生 continuable 服务接入平台持久化身份、当前授权、统一预算、取消与结果账本；
没有另建 Agent 模型循环。开发、自审和独立对抗审查由 Codex 完成，不设置 Gemini 开发门禁。

本页登记已提交并分项实测的实现，不把分支分项测试汇总成最终联合验收：

- 提案安全链提交：`9480e2212a75c1526015fdf85cb24816bd319f05`。
- 子提案拒绝不取消 Rice / 兄弟助手：`4830d0cdc05b5bdde00f2074d19dc8fe79d0723d`。
- 生产接线、缓存计量、撤权停止、child 用量、冷恢复：`06bf13dea917e7616d9c7dfe86ac7bd0f98a0b89`。
- 精确原生查询审计与实际 P04 提案闭环：`76a155bc548754a86f13fca85b2c7d16f2fd0ca0`。
- authoritative 完成状态与全树用量传递：`06aadb1c90167964c9c1c0534772dadbd07ee2b0`。
- 在途模型流的当前授权轮询与完成竞争窄修：`ae8d323544a72133bb83f0f9bff38b68355edf56`。
- 服务端输出协议 preflight：`1645af2`；冻结前动态输出 grant 与一次性模型 dispatch：`4c9969c`。
- 费用未知契约、落账与读者：`d685ab3ac61950a0af22bc366f7b4d4d27f6c338`；
  迟到旧 writer 不得消除未知：`4c49123da18e7a43ea533985a04c7a0f3563597f`。
- 独立查询测试：`f2bacaad53c5532a1746cc4010fcb914526bb6cb`，本页同次变更继续补齐 partial / 全树用量断言。
  上述是变更来源 SHA，不是一个最终发布候选；冻结集成 source SHA、build/package 和联合证据仍是后续门禁。
- DSH 固定来源与分发见 `apps/worker/dsh/upstream.json`、锁文件和
  [P24 PoC](./p24-dsh-collaboration-poc.md)。P24 的历史结论不自动证明 P25 生产适配。

本地分项证据：提案安全链在其提交版本实际运行 authority 58 项、proposal 22 项、governed 81 项通过；
governed 另有 4 项浏览器/VM 环境未启用而跳过。后续 proposal 夹具/拒绝修复对应 24 项真实 PG 通过，
并运行 database 类型检查、相关文件 ESLint、Prettier 和 diff 检查。
这些数量不是最终组合版本的统一通过计数。生产控制器与真实模型、双设备、签名客户端联合证据须另记。
整合上述 source 变更的独立工作树，又实跑 read-native、production-native、usage 三个测试文件 24 项通过：
包括 7 项查询归属/拒绝/partial 回归、缺失全部或单维 provider usage、撤权后真实 HTTP 流关闭。
另单独运行 production native P04 approve/reject 2 项通过，及 Worker 类型检查与 owned test ESLint/Prettier 检查。
模型与查询响应为合成 loopback 数据，不是真实 provider 或外网研究证据；最终集成大回归由主任务独立登记。

`ae8d323` 的本地定向回归共 29/29 通过：production native 9 项、current-authority PG 3 项、
既有 native 4 项、adversarial 11 项、production native P04 approve/reject 2 项。
其中撤权负例先确认父模型三轮调用全部结算，再对两条被挂起的子模型 HTTP 流分别撤销
membership、policy、employee、assignment 或能力开关，验证实际断流、未知预留保留且不伪造停止回执。
正常完成用例保持 DB 终态 750ms 后原生宿主仍可响应，并在同一 Session 上执行下一独立 Run，
验证新 root/lease/预算不继承旧结果，旧树不变。另验证取消后无新 grant 仍可清理、精确身份拒绝，
以及持有 job 行锁跨过租约期限后仍拒绝。Worker/database 类型检查、Worker 依赖构建、相关文件
ESLint/Prettier/diff 检查通过。这是该窄修的分项证据，不声明主任务最终联合验收、真实 provider 或 GA 通过。

两阶段准入的 `4c9969c` 工作树实际运行 14 个文件、191 项 PG / native 回归全部通过，
包括精确剩余额度、同 call 并发、跨身份、未知预留、原生 HTTP 实际输出参数和既有 P25 安全链。
Worker 依赖构建、database / Worker 类型检查、相关文件 ESLint / Prettier / diff 检查通过。
这是该 source 的受影响分项回归，不是主任务最终组合版本的验收计数。
独立 preflight 测试来源 `23faf34`，随后在含上述两阶段代码的工作树实跑 7/7 通过：
真实 Worker 的已知零失败写入真实 PG 双表并读取 quota；测试明确拦截 native acquire，未调用 provider。

## 支持范围与权威来源

| 领域   | 已实现的有界机制                                                                                                                      | 不应推导的能力                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 模式   | 严格 `version:1, mode:daily`；默认 `allowAssistants:false`                                                                            | Boost / Teamwork、自动升级模式或计划批准                                        |
| 调度   | 最大并发 4、深度 3、累计子任务 16；默认 2 / 1 / 4；原子校验父子工具交集                                                               | 跨 Worker 实时调度、无限递归、重启重置预算                                      |
| 身份   | 每个 child 是真实 `allrice_runs`；root/parent/native Session、消息和 Worker incarnation 持久化                                        | 仅猜到 native ID、模型自报 childId 或进程内对象即获得权限                       |
| 权限   | 冻结 employee execution snapshot + 当前 membership/assignment/employee/policy + 精确 task/project + Worker job/lease/generation/fence | 仅凭浏览器偏好、通用 storage/read 能力、prompt tool filter 或旧签名获得助手权限 |
| 预算   | 根任务共享 model/tool/input/output 维度；冻结前输出 grant、派发前输入预留；未知用量保留；重复派发拒绝                                 | 未知用量为零、成功文本等于结算完成、独立子预算或权威价格估算                    |
| 消息   | 幂等 inputId、payload digest、native messageId、durableSeq、adoptedSeq 分离                                                           | ACK 等于落盘、文本提到 ID 等于采用、网络中断等于未执行                          |
| 结果   | 持久 delivery；平台登记工件 ID/digest；pending 操作不能以模型报告变成成功；父采用另记                                                 | idle 或“完成”文本就是交付；有报告必然唤醒父任务                                 |
| 提案   | 第一版仅有界 `local.process.execute` 经平台 P04 精确审批、Broker、执行 receipt                                                        | 原生 approval=never 被整体放宽、任意副作用工具或后台服务已获支持                |
| 产物   | 子 namespace、同租户/owner/child 工件登记；受控 publisher 接入既有工件查看链                                                          | 本地源文件已修改、自动合并、生产项目并行协作写入                                |
| 工作台 | 持久树/消息/结果/审批是后续 UI 与刷新恢复的数据权威                                                                                   | 单独数据库 API 即证明 P26 工作台完整或 P27 端到端已通过                         |

`ALLRICE_ASSISTANTS_ENABLED=1` 只是部署能力开关，不授予用户/员工权限。
每次 configure/delegate/message/model/tool/proposal 的执行准入仍由服务端重建授权；
冷恢复只读证据导入另查当前 owner 与新 Worker lease，且不重新授予执行权。
必须冻结 daily + allowAssistants，并显式绑定员工工具 `assistant.delegate`。
普通发布新 employee version 不自动撤销一个合法冻结中的版本；当前停用、撤权、取消仍在每次新准入重检。
已绑定宿主的活动模型流另由只读当前授权轮询检查；撤权失败关闭本 Worker 已拥有的宿主，
不是只等待下一次模型/工具准入。该机制不声称能够撤回已经发生的外部设备动作。
缺失 policy、未知配置、旧版不支持的 snapshot、替换 root/project、跨租户和过期 lease 默认拒绝。

所有已接工具仍须同时满足冻结权限、父工具集、此次明确委派工具集与当前政策交集。
第一版没有额外的逐文件委派 ACL：明确选择 workspace document/memory 查询工具意味着可读取
根执行上下文已有权读取的同租户工作区资源，不代表仅可读 prompt 中附带的文件。
`workspace.session.search` 只返回 Session ID、标题、更新时间，不返回聊天正文。
原生新子会话不会自动复制整段父聊天；这与授予某个查询工具后主动查询授权资源是两种行为。
如果任务需要“只能读指定文件/片段”，当前工具级委派不能表达该限制，不能把它宣传为已实现。
首版 child 查询为显式 allowlist：`workspace.skill.read`、`workspace.document.read`、
`workspace.memory.search`、`workspace.session.search`、`web.search`。
`browser.run`、本地 Bridge 读取等尚无 child 生命周期适配的路径，在 provision 前拒绝，
不能因为 manifest 标记 read_only 就自动下放。

## 模型输出上限、两阶段准入与协议门禁

固定 SDK 在 `prepareCall` 冻结模型配置后不支持修改请求上限。
生产助手通过现有 `agent/request` hook 返回新的配置，再由原生循环冻结并发送；
没有修改冻结对象、安装包或新建模型循环。

1. 在 root 锁内检查精确 Worker lease、当前 child 与当前授权，为新 callId 预留一次 model 调用，
   并计算 `grant = min(requested, capacity - spent - reserved)`；无正数余额即拒绝。
   此阶段尚不授予派发权，不挤占或缩减任何已有在途 reservation。
2. 将实际 grant 写入原生 `maxTokens`，由固定 SDK 冻结配置。
3. 派发前重新检查相同 root / child / lease / 当前授权，原子预留输入上界并保存冻结请求摘要。
   callId、grant、输入和摘要必须匹配，只有首次派发返回可执行；重复调用不能据此重放模型请求。
4. 已确认 usage 才结算。输入准入失败、授权撤销、宿主崩溃、未知 ACK 或缺少 usage，
   均不能清除已经提交的输出 hold；`finished_at` 也不等于用量完整或已知零消耗。

真实 PG 回归精确覆盖：总上限 12000、已花 246、两条 child 各预留 4000 后，
parent 请求 4000 只获 3754；满额拒绝、并发不超额、同 call 两阶段各只有一个首次成功，
以及改摘要、跨 child / scope / generation / fence / lease 的拒绝和预留不变。
production native 用 `maxConcurrent=2` 挂起两个子模型请求，验证 HTTP 中的
`max_tokens` / `max_completion_tokens` 与每条持久 grant 完全一致，不只是减少账本预留。

协议门禁只看服务端实际冻结 / 重放的 provider snapshot，浏览器偏好不能自报支持。
当前只登记 `dsh + openai-compatible`、`dsh + gemini` 两种有源码及 loopback HTTP 字段证据的协议：

- Compatible 的上述 production native 测试覆盖动态 grant 到实际请求参数。
- Gemini 独立固定 SDK / `@google/genai` HTTP 测试两项通过：alias 与 canonical flash 路线分别发送
  `generationConfig.maxOutputTokens=3754 / 1024` 并读取合成 usage。
  这只是协议字段证据，不证明动态助手全链、真实 Google 执行上限、真实模型任务或 tenant-enable。
- 当前固定 Codex responses 实现没有把 `maxTokens` 写入响应请求的输出上限字段；
  因此 **Codex 助手当前关闭**，不能通过提高根预算、客户端声明或换调用入口绕过。
  这不等于证明 Codex 后端永远不支持该字段，也不授权修改上游安装包。

`allowAssistants:true` 的不支持协议在 Worker 标记未知账务之前拒绝；adapter 另在 credentials / host
获取之前复检，使用非重试 `ASSISTANT_PROVIDER_OUTPUT_BOUND_UNSUPPORTED`。
这是已知未发生模型调用的失败，记零用量 / 零费用且完整，不制造未知费用锁住组织；
既有失败 Run 计数仍增加，也不能清除组织此前真实的 unknown。
已进入助手执行后的普通异常继续保持费用未知和用量不完整，不按错误字符串伪造零账。
未配置助手或 `allowAssistants:false` 的普通 Codex 路径不受此门禁影响。
P27 当前 Codex 助手请求应保持明确 blocked，不静默替换 Gemini，也没有新的真实 provider 成功证据。

## 精确命令提案与锁顺序

生产 Worker 内部向 `createLocalCommandOperation` 传入：
`assistant: { runId, worker: { jobId, workerId, leaseToken, generation, fence } }`。
该结构不进入公开工具参数 schema；模型不能覆盖 root、child、scope、lease 或审批绑定。
操作的 immutable `initial_snapshot.agentInstanceId` 是实际 child Run UUID，
原 root ExecutionContext、参数摘要、目标、版本、期限与 P04 精确审批保持原有权威。

configure/delegate 可以登记 ask-bound 的 `local.process.execute`，专用 proposal phase 可以送审；
普通 tool phase 不能把 ask 当 allow。其他 ask-bound 工具没有这个例外。
提案、批准后的 dispatch、heartbeat 以及事务末端均重建 child 当前授权。
统一锁序为治理 root → assistant root/child → policy controls/approval，锁等待后再次检查实际 lease 时间。
重启后重新创建 ledger 也读取 immutable origin，不能由旧 closure 或可变 snapshot 绕过。

拒绝、到期或撤销一个 child 提案，只取消该 child 的待决操作，不取消主 Rice 或兄弟助手；
child 可报告失败/部分结果。预派发 canceled 可提供 `notExecuted:true`；已派发仅截止新准入并等待执行端证据，
不能把取消请求直接显示为远程进程已杀掉。普通非助手命令维持既有路径。
命令 operation 自身计一次 tool 调用，原生协调工具另计一次平台调用；不是宣称执行了两次外部命令。

## 取消、未知状态与保守冷恢复

取消单个助手作用于其子树；取消整项任务先持久化根 tombstone，关闭新委派/消息/工具/模型准入，
再停止原生活对象、排空后代并处理对应 operation。`cancel_requested` 与 `stoppedAt` 必须分开。
原生模型流停止不证明设备进程停止；设备离线、receipt 缺失或未知外部动作继续保留不确定状态。
晚到结果可作为证据保留，但不能改写已终止实例或唤醒取消的父任务。

冷恢复首版采用“先隔离、后核对，不自动重跑”：

1. 新 Worker 必须持有当前 job lease。旧 lease 的精确 digest 与 generation/fence 不匹配即不能继续旧执行。
2. 旧执行权被撤销后，实例/可能已提交消息保持 unknown；不得凭重启或空内存 mailbox 重新投递。
3. 只读检查同 native Session 的实际 JSONL。只有已知 native messageId 的精确 inbox/user-message 记录，
   才可补 durable/adopted checkpoint；内容里出现某个 ID 不算证据，未知 ACK identity 不猜测补全。
4. 补 checkpoint 不重新开放执行、不释放未知用量、不接受业务完成结果、不唤醒父任务。
   未确认的写操作转核对/人工处理；没有自动续跑、分布式接管或全副作用 exactly-once 承诺。

读取恢复历史不等于成功恢复运行。SIGKILL/JSONL 测试只覆盖进程故障；不覆盖整盘丢失、文件系统损坏、
跨主机迁移或灾难恢复。旧 Worker 仍可能持有在途外部请求，fencing 只截止后续准入，不能撤回已经发生的动作。
如原生执行权无法可靠隔离，必须保持 unknown/禁止接管，不能以删除 DB 行或换一个 child ID 作为恢复。

## 独立读审发现的修复与仍开放的门禁

源码与回归已对应修复，不以文档豁免代替修复：

- 缓存计量：固定 DSH 的 uncached input + cacheRead + cacheWrite 合计，并检查 safe integer。
  SDK 对缺失远端 usage 可能合成零；非空输入的零 input、观察到真实输出但 output 为零，
  都保留相应预留。见 `06bf13d`、`06aadb1` 的 usage 单测和 production 实际 HTTP 缺字段负例。
- membership 撤权：轮询失败强制关闭已拥有的宿主，catch/finally 保证关闭；真实 HTTP 流关闭回归通过，
  不把宿主退出捏造成远端操作 stopped receipt。见 `06bf13d`。
- 在途授权轮询：`ae8d323` 补齐 policy/employee/assignment/能力开关撤销后的活动流停止。
  `assertCurrentAuthority` 在同 root 锁内复核 scope、精确 Worker incarnation、当前权限与末端租约时间；
  已提交 root 取消可跳过新 grant，但不能跳过精确租约或末端时钟检查。
  native join 确认全树 idle 后，先停止并等待在途轮询，再进行原生释放及 DB 当前授权 finalization，
  避免正常终态被误判撤权；强制关闭中的宿主不再竞争第二次 native drain。
  上述原 pending P1 已由窄修及本页 29/29 定向证据关闭，不推广为所有外部副作用或最终联合验收通过。
- 结果：DB 锁内从本 child 用量推导，report 自身已知协调调用先结算；未知用量使 completed 降为 partial，
  不因兄弟预留误判。见 `06bf13d` 的真实 PG 用量测试。
- 查询：`06bf13d` 显式纳入 web.search 并在创建 child 前拒绝未支持 Browser/Bridge 读取；
  `76a155b` 持久记录 childRunId、nativeCallId、toolName、参数/结果摘要，非模型可覆盖权限。
  独立 read-native 7 项经过真实生产宿主与 PG，查询结果为合成数据，不声称真实外网已验收。
- 整项任务：`06aadb1` 从根预算返回父子孙全部 confirmed usage，不再只回报 initial parent turn。
  unknown 非重试失败，保留 unknown/预留、不被 catch 取消覆盖；partial 有明确前缀与结果标记，
  保存可用结果后 Worker 非重试失败，不把整项 job/route 标成功。已知用量与未知费用是不同维度。
- P04：`76a155b` 的 production native approve/reject 测试接真实父子、P04 和合成执行 receipt，
  拒绝未派发操作计零执行用量；它不是实际 VM 或签名客户端证明。
  旧 P24 未映射 native ID 的四项用例现是迁移拒绝回归，不能再列为当前正链证据。
- 路由账单：`d685ab3` 保存 SQL NULL 与完整性标志，quota/admin/employee reader 不把未知求和成零；
  `4c49123` 拒绝普通迟到 writer 将 NULL 改数值、false 改 true、降低已确认用量；保留首次 completedAt，不能挪动结算月份。
  首次旧 numeric writer 和精确重放兼容；未知转已知需要另有权威证据的核对流程，不由普通重放承担。

仍开放且阻断 tenant-enable：当前未冻结权威价格/缓存价格账，助手 `costEstimateAvailable:false`，
费用落 NULL；组织 quota 随后会 fail-closed 阻止后续模型路由，包括单 Agent，不能把未知当免费放行。
没有可靠价格或已授权核对闭环前，不向真实租户启用或灰度助手。
P27 直接 adapter 的隔离 smoke 不等于完整 Worker 路由/费用落账/配额验收，也不证明真实组织后续可继续运行。
真实 provider/业务任务、完整 P26 交付、双设备、签名/公证/安装与最终包联合验收仍未由本页证明。

## 验证地图与安全复现

下表说明测试职责，不声称所有测试在最终组合 SHA 已通过；生产模型测试夹具使用合成 loopback HTTP SSE。
真实 PG、原生 DSH 进程、JSONL 和权限代码可以是真实的，同时模型回复仍是合成的，两者必须同时标注。

| 测试文件                                                                                                  | 证明的边界                                                                     | 不能替代                         |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------- |
| `packages/database/src/assistant-runtime.integration.test.ts`                                             | PG 身份/并发/预算/消息/取消/结果/lease 状态机                                  | 生产宿主接线和真实模型           |
| `packages/database/src/assistant-authority.integration.test.ts`                                           | 冻结/current policy、工具、actor、版本、项目与撤权负例                         | 前端按钮或租户启用授权           |
| `packages/database/src/assistant-current-authority.integration.test.ts`                                   | 只读实时授权、取消后无新 grant 清理、精确身份及等锁后租约过期拒绝              | 原生流停止或最终联合验收         |
| `packages/database/src/assistant-output-budget.integration.test.ts`                                       | 固定 4000 请求在剩余 3754 时被旧全额准入拒绝、并发 / 未知预留根因证据          | 动态 grant 成功或真实 provider   |
| `packages/database/src/assistant-model-admission.integration.test.ts`                                     | 两阶段精确 grant、满额、同 call 并发、摘要 / 身份拒绝与未知 hold               | 实际 HTTP 参数或 provider 执行   |
| `packages/database/src/local-command-assistant.integration.test.ts`                                       | 实际 P04 + immutable child、lease、dispatch/heartbeat、并发锁序、单 child 拒绝 | 真设备命令/实际签名客户端        |
| `packages/database/src/runtime-governed-bridge.integration.test.ts`                                       | 既有精确审批执行链及旧未映射 child 的拒绝回归                                  | 新 production native 正链        |
| `packages/database/src/assistant-output.integration.test.ts`                                              | 根/子、storage owner、隔离工件与工件读取                                       | 真实研究产物正确性               |
| `apps/worker/test/p25/assistant-adversarial.integration.test.ts`                                          | 独立攻击式 PG/native 复现：伪工件、重复结果、晚取消、预算/租约、实际 drain     | 完整 MET-108 A～D 验收           |
| `apps/worker/test/p25/assistant-native.integration.test.ts`                                               | 固定原生服务、独立并发子会话、单 child/整树取消、SIGKILL/JSONL                 | UI 刷新、真实付费 Provider、灾备 |
| `apps/worker/test/p25/assistant-production.integration.test.ts`                                           | 生产 adapter/受限宿主/controller + 实际原生服务 + 合成 SSE                     | 真实模型/真实设备联合场景        |
| `apps/worker/test/p25/assistant-gemini-output-bound.integration.test.ts`                                  | 固定 Gemini SDK 实际 loopback HTTP 输出上限与合成 usage                        | 动态助手全链或真实 Google 验收   |
| `apps/worker/test/p25/assistant-provider-preflight.integration.test.ts`                                   | 实际 Worker 已知零 preflight、真实 PG 双表 / quota、普通兼容与执行后 unknown   | 真实 provider 调用或租户可用性   |
| `apps/worker/test/p25/assistant-read-native.integration.test.ts`                                          | 五类查询的真实 child dispatch/采用、精确审计、拒绝未支持委派、partial 全树用量 | 真实云端资源/外网查询或租户启用  |
| `apps/worker/test/p25/assistant-proposal-native.integration.test.ts`                                      | 生产 native child → P04 批准/拒绝 → 合成 receipt 与 Worker partial guard       | 实际 VM/设备命令及签名客户端     |
| `apps/worker/test/p25/assistant-usage.test.mjs`、`apps/worker/src/harness/dsh/assistant-recovery.test.ts` | 固定 token 字段映射和精确 checkpoint 提取                                      | PG 状态机与实际进程恢复          |

仅对用户已授权的本地测试库运行，fixture 每次建立随机 schema，结束只清理本轮精确 schema。
不读取 `.env` 或凭证，不对真实应用 schema 运行迁移/种子/清理。示例：

```sh
ALLRICE_RUN_DB_INTEGRATION=1 ALLRICE_TEST_DATABASE_URL=postgresql://a123@127.0.0.1:5432/allrice_b2 pnpm exec vitest run packages/database/src/assistant-runtime.integration.test.ts packages/database/src/assistant-authority.integration.test.ts packages/database/src/local-command-assistant.integration.test.ts
ALLRICE_RUN_DB_INTEGRATION=1 ALLRICE_TEST_DATABASE_URL=postgresql://a123@127.0.0.1:5432/allrice_b2 pnpm exec vitest run apps/worker/test/p25/assistant-native.integration.test.ts apps/worker/test/p25/assistant-adversarial.integration.test.ts apps/worker/test/p25/assistant-production.integration.test.ts
pnpm --filter @allrice/database typecheck
pnpm --filter @allrice/worker typecheck
```

只有测试子进程内允许 fixture 临时置助手开关；这不是启用本机服务或任何租户。
记录命令、完整 source SHA、固定 package/build、环境、通过/失败/跳过、日志哈希及未验证项。
跳过、超时、未知或只有退出码没有作用域的报告不能作为验收通过。

## 发布与回退仍是单独门禁

开发合并、Dev 部署、租户启用、签名客户端分发、Prod 分别需要各自授权。
默认保持助手关闭；关闭阻止新执行，并由活动授权轮询关闭已拥有的原生宿主，
不代表外部设备动作已停止，不能删除历史/未决操作来假装回退完成。
迁移 `0093_assistant_runtime.sql` 是 expand 底座；回退优先保留兼容读、取消/核对能力和新表证据，
不能直接 destructive down migration，不能倒退到无 child 检查的旧 Worker 重读或重放任务。
存在无法兼容的状态时使用 forward-fix，不以 schema 删除、旧凭证 reader 或忽略未知记录作为回滚。
`0094_model_usage_unknown_cost.sql` 放宽费用列并增加完整性标志，不重写历史 numeric 值；
产生 NULL 费用后也不能回到忽略 NULL 的旧 quota reader 或把 NULL 当零的旧 UI。
回退须保留这些兼容读与额度保护；不通过重写未知账单为零或恢复 NOT NULL 伪装兼容。
`0095_assistant_model_admissions.sql` 仅增加两阶段准入证据表，不改写既有 usage；
回退仍须保留准备 / 派发 / 完成身份和未知 reservation，不能换旧全额请求路径重放已有 call。

P27 负责真实任务、刷新/重开、权限和设备联合验收；P28 的
[发布准备](./p28-release-readiness.md) 与版本固定 manifest 校验负责证据完整性，不能替代这些实际场景。
P14 签名/公证、两台实际客户端与最终安装包的外部依赖仍按其门禁登记；本页不核查凭证，不承诺签名可用。
108-E 开发协作、108-F Boost、108-G 完整 Teamwork 仍属后续范围；不能关闭整个 MET-108 Epic 来替代承接。

## 2026-09-14 收尾增补

503/缺少用量的原生 Gemini 助手请求曾被上层重试三次，现保留不可重放 admission，只有两个 Token 维度已知且平台结算 ACK 成功才释放。普通未绑定助手的模型重试策略保持原样；定向真 SDK/PG、合成 HTTP 回归包含修复前反证，不是实际 Google 执行收据。

0096 追加价格快照与逐调用回执，不回填旧 unknown。生产 Worker 仅在助手路径使用显式 `ALLRICE_ASSISTANT_PRICING_JSON` 和 `ALLRICE_ASSISTANT_PRICING_CURRENCY`，精确匹配已冻结路由、connection/catalog、实际模型、API endpoint、服务等级、币种、有效期和纯文本价带；缺价先拒绝，不用普通聊天的缺价=0行为。真实总用量已确认而缓存拆分未知时，费用是最高输入单价计算的保守上界，不是供应商账单。所有父子调用按根汇总，任何未知调用/回执仍保持 unknown。

当前旧月额度账本没有币种列，因此生产 Worker 和 controller **只允许显式 USD**；其他币种在派发前拒绝，不设置默认币种、不隐式换汇。通用价格合同/回执保留 currency 字段，不代表旧账本已支持多币种。启用真实租户前还必须核对普通聊天既有价格配置也是 USD 口径；不推断历史金额的币种，不修改历史账单来假装兼容。

完整 Token 容量的上界必须落在所选价带及明确费用限额内；价格有效期覆盖整个有界任务。恢复保留已冻结价格和调用回执，禁止事后改价、低报缓存、重复采用计费、把旧 NULL 改为零。相关开发及测试边界见 [本批收尾记录](./b6-closeout-20260914.md)，真实模型/Worker 后续配额与最终 P27 矩阵须独立留证，不能仅依据新增代码关闭工单。
