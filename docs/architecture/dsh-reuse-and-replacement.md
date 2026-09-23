# DSH 复用与替换清单

本页是 Allrice 对上游 DSH 的持续复用决策入口，跨 2.x / 3.x 维护。每次升级先检查上游是否已解决我们的适配问题，再决定保留、替换或退役；不能把历史补丁默认当成永久实现。

运行事实仍以 [upstream.json](../../apps/worker/dsh/upstream.json)、[distribution.json](../../apps/worker/dsh/distribution.json)、[compatibility.json](../../apps/worker/dsh/compatibility.json)、[patch-ledger.json](../../apps/worker/dsh/patch-ledger.json) 和依赖锁为准。本页不控制发行渠道、工具授权或候选发布。

## 本轮复核

- 日期：2026-09-24；负责工单：[MET-154][met154] PR-4。固定候选兼容升级与图片转换局部退役已合并，Dev 普通任务、恢复及 M5 真实开发交付均已验收，临时配置已恢复；业务归属见各项原工单，模块化归 MET-155。
- Allrice 基线：`a77c640`；已核对 main 的 CI、Dev 已验收代码及全部开放 PR。
- 复核范围：当前 `0.1.1-rc.2` 源码 `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` → 已安装候选 `0.1.5-rc.3` 源码 `a4c74a91e06b00fe0b0937bde982170c526cc842`。
- `0.1.7-alpha.2` / `00102833dfaee1da9f48a3a8eae9d34005a75218` 只作为前瞻研究。下表所有上游链接固定到对应源码 SHA。
- 精确包差异、协议矩阵、迁移实测和发布阻断项见 [本轮升级基线](dsh-upgrades/met154-rc3-baseline.md)。PR-2 已完成受限组合、私有事件迁移和助手接口适配；实现与发布限制见 [候选兼容验收](dsh-upgrades/met154-rc3-compatibility.md)。`installedChannel=candidate` 本身不证明部署或晋级；实际 Dev SHA、真实账号/旧会话/重启及 MET-144 开发交付结果见 [PR-4 验收](dsh-upgrades/met154-rc3-dev-validation.md)。本轮 Dev 已验收，不代表 Prod 晋级。PR-3 的具体删除、接口差异与保留理由见 [复用收敛记录](dsh-upgrades/met154-rc3-reuse.md)。

状态含义：**保留**＝上游没有承担对应 Allrice 责任；**可复用待验证**＝有重叠但还不能删旧路径；**适配后替换**＝已找到替代接口，待通过同等行为验证；**已替换**＝删除旧路径的 PR 和证据齐全；**明确不接入**＝本轮不启用该执行面。来源存在不等于产品已启用，也不等于验证通过。本轮仅图片准入后的引用转换标记为“已替换”；所属生命周期适配整体保留。

## 已登记的 10 项适配

以下条目的复核日期/版本统一继承“本轮复核”。测试路径以仓库根目录为起点。退役必须在同一 PR 删除相应旧实现、更新机器清单并留下验证结果；一项适配中的少量机制可退役，不代表它承担的整项治理责任可以删除。

### allrice-durable-native-question-wait-v1

- ID：`allrice-durable-native-question-wait-v1`；归属 MET-153；**保留**。
- Allrice：[allrice-dsh-waits.mjs](../../apps/worker/dsh/allrice-dsh-waits.mjs)、[allrice-dsh-inputs.mjs](../../apps/worker/dsh/allrice-dsh-inputs.mjs)。负责静止提问检查点、确切答案采纳、同 Run 续接和派发未知不重放。
- 上游：[rc.3 Session 持久化][persistence]提供历史格式迁移和恢复机制，不承担 PostgreSQL 租约/问题授权。[v0 迁移校验][v0-validation]拒绝未知历史事件，单纯向当前词表注册私有事件不能解决这个迁移问题。
- 退役条件：候选原生机制覆盖静止边界、持久答案幂等及续接意图，且 Worker 权威检查仍在；当前无整项替代。先完成显式私有事件迁移，不删除事件或标记 ignorable 来通关。
- 验收：`dsh-legacy-replay.test.ts`、`task-wait-native.integration.test.ts`、`task-wait-worker.integration.test.ts`，以及数据库 `task-native-wait.integration.test.ts`。回退需同时保留私有事件读写能力与原格式副本。

### allrice-durable-progress-guard-v1

- ID：`allrice-durable-progress-guard-v1`；归属 MET-153；**保留**。
- Allrice：[allrice-task-progress.mjs](../../apps/worker/dsh/allrice-task-progress.mjs)、数据库 `task-progress.ts`。模型/工具事实交给持久暂停策略，用户选择继续/取消；调用次数仅统计。
- 上游：[重复工具提醒][repeat]是模型提示策略，[Goal driver][goal]是目标推进机制，都没有等价的租约、跨进程暂停状态和精确决策账本。
- 退役条件：上游提供可接入现有权威状态的等价事实回调与暂停机制，并覆盖失败、空进展、取消和重启；PR-2 已适配 `user-questions/request`，保持原策略，不引入固定调用次数上限或第二套 Agent 循环。
- 验收：`task-progress-native.integration.test.ts`、数据库 `task-progress.integration.test.ts`。回退保留暂停记录和原决策版本，不通过清空状态“恢复”。

### allrice-durable-task-clock-v1

- ID：`allrice-durable-task-clock-v1`；归属 MET-153；**保留**。
- Allrice：[allrice-assistant-runtime.mjs](../../apps/worker/dsh/allrice-assistant-runtime.mjs) 向 Worker 报告真实 idle；权威计算在 `packages/database/src/task-clock.ts`。
- 上游：[子助手的 idle、结算与 Inbox 状态][subagent]可提供更精确的事实，但不拥有 Allrice 的 PostgreSQL 时钟、并发参与者和跨 Worker 租约。
- 退役条件：可以替换重复的 idle 探测，不能迁走权威时钟。需要证明助手活跃/工具未知时不暂停、多个参与者时间取并集、等待不耗预算、接管不重置。
- 验收：`task-clock.integration.test.ts`、`task-wait-worker.integration.test.ts`。回退读取同一时钟表，不能另起内存计时器。

### allrice-development-workflow-v1

- ID：`allrice-development-workflow-v1`；归属 MET-144；**保留**（PR-3 已复核；原生派发已复用，剩余为平台治理）。
- Allrice：[allrice-assistant-runtime.mjs](../../apps/worker/dsh/allrice-assistant-runtime.mjs)、数据库 `development-cooperation.ts` / `development-workflow.ts`。现有 message/report/stop 已使用原生子助手，不是从零搭建消息系统。
- 上游：[rc.3 subagent][subagent] 用 `sendMessage` 取代旧 `followup`，PR-2 已改用 Host 专用 `queueHostSubagentPrompt` 保留 Queue 与 coordinator 来源，不能用会唤醒接收者的 `sendMessage` 冒充旧 quiet report。冷恢复使用官方 session-query-sqlite 的 `openAt: never`，仅启用精确读取，不创建索引或注册模型查询工具；[Agent Team][team]有持久排队→目标采纳→ACK、任务 revision CAS、事件等待和中断后保留 Inbox，可借鉴这些机制。
- 退役条件：只替换重复派发/唤醒/等待路径；固定候选 SHA、同版本测试、独立审查、文件 CAS、租户授权和交付证据仍由 Allrice 核验。Team 的单进程任务板不能成为 PostgreSQL 队列的第二个权威来源，`writeScopes` 也不是锁。
- 验收：数据库 `development-cooperation.integration.test.ts` / `development-workflow.integration.test.ts`、`apps/worker/test/p25/assistant-production.integration.test.ts` 和 MET-144 真实交付链。回退必须排空候选助手树，不能让旧/新两个协调器同时投递。

### allrice-assistant-required-delivery-v1

- ID：`allrice-assistant-required-delivery-v1`；归属 MET-151；**保留**（PR-3 已复核；原生结算通知仍需平台授权后唤醒）。
- Allrice：[allrice-assistant-runtime.mjs](../../apps/worker/dsh/allrice-assistant-runtime.mjs)。report 权限、输出 grant、证据结构、幂等通知和可修正参数错误都属于 Allrice 合约。
- 上游：[子助手结算][subagent]、[alpha.2 完成唤醒修复][alpha-release]可降低消息适配成本，但 native idle/结束仍不等于已提交可验收结果，alpha 修复也不能推定 rc.3 已包含。PR-3 核对后保留 `guardSettlement` 与 delivery 去重，具体差异见 [复用收敛记录](dsh-upgrades/met154-rc3-reuse.md)。
- 退役条件：原生唤醒保留真实平台 report、拒绝重复/换父节点通知，且不制造成功。需逐段删除旧唤醒包装，而不是只增加一条新路径。
- 验收：`assistant-native-delivery.test.mjs`、数据库 `assistant-output.integration.test.ts` / `assistant-output-budget.integration.test.ts`。回退保留 durable delivery ID，避免第二次投递。

### allrice-workbench-native-changeset-v1

- ID：`allrice-workbench-native-changeset-v1`；归属 MET-147；**保留**。
- Allrice：[allrice-workbench-native-tools.mjs](../../apps/worker/dsh/allrice-workbench-native-tools.mjs)。向模型表达已有 Broker 的提案格式，不能直接应用到设备。
- 上游：[Tool presentation][presentation]可复用描述/展示机制，不拥有 Allrice 目标绑定、Bridge 授权、精确审批、artifact 身份或文件 CAS。
- 退役条件：上游声明能力能无损描述既有契约，且模型看到的 schema、Broker 校验与交付血缘完全一致；平台执行边界不退役。
- 验收：`dsh-protocol-runtime.test.ts` 中交付血缘契约、`workbench-native-tools` 相关测试以及 changeset/Bridge 回归。回退保留未决审批的原始目标与内容哈希。

### allrice-bounded-native-search-v1

- ID：`allrice-bounded-native-search-v1`；归属 MET-150；**保留**。
- Allrice：[allrice-jsonrpc-runtime.mjs](../../apps/worker/dsh/allrice-jsonrpc-runtime.mjs) 的 Broker 搜索回调；负责限额、审计、结果裁剪和完整结果文件。
- 上游：[tool-web][web]具备搜索/网络工具；具备相同工具名不代表满足租户来源策略和持久结果授权。
- 退役条件：上游可挂接现有 Broker，完整结果仍为受控 artifact，重复调用与超大结果验证通过；不允许原生直连绕过审计。
- 验收：`dsh-adapter.test.ts` 中 native search 单 turn/工具事件路径及现有搜索 Broker 测试。回退复用已有操作身份，结果未知不重试副作用。

### allrice-jsonrpc-lifecycle-v1

- ID：`allrice-jsonrpc-lifecycle-v1`；归属 MET-85；**已替换**（图片准入后的有序引用转换）；生命周期扩展保留。
- Allrice：[allrice-jsonrpc-runtime.mjs](../../apps/worker/dsh/allrice-jsonrpc-runtime.mjs)、[allrice-dsh-runtime-compatibility.mjs](../../apps/worker/dsh/allrice-dsh-runtime-compatibility.mjs)。承担发行身份、Broker、会话恢复、压缩和 typed input 的受控桥接。
- 上游：[SDK server][sdk] / [wire types][wire]新增 inline image admission、初始化就绪和 reasoning effort 校验，但 SDK inline image 不传递 `name`，不能直接替代现有有名附件。PR-3 改用 rc.3 新增的 [AttachmentStore.admitPromptContent][attachment-admission]，复用原生准入及有序引用转换，并删除 `admitDshPromptImageBlocks`。上游握手版本仍为 `0.0.1`，不能用它替代 Allrice 发行版本核验。旧 `Session.events` 读取及内容事件格式已有变化。
- 保留范围：`prompt` 只把现有 wire images 标记为原生图片片段，保留 display name；SDK 继续创建消息身份与排队。租户授权、冻结附件及校验和仍在 Allrice。SDK 覆盖名称后才考虑删除这层 wire 桥接，不开放默认工具组合。
- 验收：`dsh-images-native.integration.test.ts` 覆盖真实存储拒绝边界、整批拒绝、名称/顺序、消息 ID 与进程重启；已纳入 `dsh:golden-replay`。实现与验证见 [PR-3 记录](dsh-upgrades/met154-rc3-reuse.md)。回退此局部替换可在相同 rc.3 构建恢复原 helper；这不授予 v3 历史降级到 rc.2 的资格。

### dsh-admin-webui-private-entrypoint-v1

- ID：`dsh-admin-webui-private-entrypoint-v1`；归属 MET-100；**保留**。
- Allrice：[dsh-webui-compatibility.mjs](../../apps/dsh-admin/dsh-webui-compatibility.mjs)。隔离私有 `@deepseek-ai/dsh/lib/bin.js`、启动参数与管理员入口。PR-2 新增受信任 Host 插件，经父子进程 IPC 提交原生 `authenticatedUrl`；网关内部交换和定时更新 cookie，浏览器仍只持有 Allrice 管理员会话。HTTP/API 的 Host 与 Origin 必须先通过网关校验。
- 上游：[rc.3 CLI manifest][cli]仍以 `lib/bin.js` 暴露可执行文件；这不是稳定的 Allrice 管理 API。[client connection][connection]内部已有较大改动，需要连同下一项源码补丁核对。
- 退役条件：上游有满足同等参数和管理员访问边界的稳定入口，或 Allrice 不再需要原生管理员 WebUI；否则继续集中封装，不能把 Web Host 作为租户后端。
- 验收：`apps/dsh-admin/dsh-webui-compatibility.test.mjs`、管理员 gateway 授权回归及真实启动。回退使用成套 CLI、UI 资源和补丁，不能只换 Worker。

### allrice-private-session-migration-v1

- ID：`allrice-private-session-migration-v1`；归属 MET-154 PR-2；**保留**。
- 实现：[私有事实预检](../../apps/worker/dsh/allrice-session-compatibility.mjs)、`patches/@deepseek-ai__dsh-session-format-v0-to-v1@0.1.5-rc.3.patch` 和 JSONL 持久化包的对应补丁。新增四种精确 log-only 事件；主线程与内嵌 verifier 使用相同 payload 校验，Session 运行时使用同一词表。
- 复用原生 v0→v1→v2→v3 迁移、序号/引用重映射、只读句柄、代际文件及单写入者租约；平台预检会话/turn/答案/续接关系。不丢弃私有事实、不伪造答案采纳证明、不覆盖唯一源文件。
- 验收：`dsh-legacy-replay.test.ts` 的源字节不变、等待迁移、重复答案/重启续接、未知格式/事件、损坏事实与并发写入拒绝。带私有事实的 seeded/child 日志明确拒绝，不能默认为根会话。
- 退役条件：上游提供同时覆盖迁移校验器、运行时和独立 worker bundle 的版本化下游事件注册机制；届时先通过同一旧日志测试，再删除两个物理包补丁与运行时词表扩展。候选写入 v3 后禁止旧二进制继续旧历史。

## 机器 ledger 之外的源码补丁

稳定 ID：`allrice-admin-authenticated-origin-pnpm-v1`；归属 MET-100；**保留，升级时重新验证**。

[pnpm-workspace.yaml](../../pnpm-workspace.yaml) 的 `patchedDependencies` 还登记了 [client-connection 补丁](../../patches/@deepseek-ai__dsh-client-connection@0.1.5-rc.3.patch)：已认证 HTML 的 `allrice-dsh-admin` 标记让管理员 UI 使用受控网关。这是一个实际第三方包源码补丁，与 ledger 中的协议适配分开核查，不能漏审。

rc.3 [connection 实现][connection]补丁已按新 transport/ownsHost 实现重新移植；保留服务端原生认证，并用真实原生 WebUI 启动、登录、API、Host 和跨域拒绝测试验证。退役需证明新的正式远程连接入口在既有管理员认证、Host 检查和回环服务限制下工作，并通过未登录/非管理员拒绝测试。HTML 标记本身不是权限凭证。回退需要旧锁文件、旧补丁、网关和 UI 同时兼容。详见 [管理员架构](dsh-admin-console.md)。

## 值得复用的上游能力

| 稳定 ID / 能力                     | 上游存在性与 Allrice 当前状态                                                                                | 决策、验收与退役条件                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cap-agent-team` / 协作开发        | [旧源码][old-team]已有 private Team 实验，rc.3 已公开发布；Allrice 未挂载 Team，已有受控 message/report/stop | 可复用待验证。优先 mailbox 幂等、版本 CAS、事件等待。只有同一候选测试/审查/交付链不退化才替换机制；不替代跨进程队列或上线 Teamwork 产品模式。                                   |
| `cap-sdk-image` / 图片准入         | rc.3 [SDK][sdk]新增 encoded-image 准入；Allrice 已有附件桥接                                                 | 适配后替换。通过附件顺序、伪 MIME、超限及撤权路径，再删除重叠代码。                                                                                                             |
| `cap-compaction` / 压缩            | 旧版已有 compaction；Allrice 已调用 `ctx.compaction.compactNow`，不是新能力                                  | 保留原生复用。验证新 [压缩策略][compaction]的安全区间、模型路由、手动 busy 拒绝和上下文投影；不自建摘要主循环。                                                                 |
| `cap-plan-goal` / Plan、Goal       | [Plan][plan]、[Goal][goal]在旧版已有，Allrice 未启用它们的产品流程                                           | 明确不接入本轮运行面；研究 SOP/上下文表达。未来必须映射精确审批、权威时钟与取消，不另建自动重启循环。                                                                           |
| `cap-session-reference` / 会话引用 | 旧版已有 [Session Reference][reference]；Allrice 使用授权后的历史检索                                        | 可复用待验证。引用解析可以借鉴，但必须证明租户隔离、会话 ACL、冻结 Skill 和只读范围，才能替换自有引用适配。                                                                     |
| `cap-code-mode` / Code Mode        | 旧版已有 [tool presentation][presentation]；“代码式展示”不能等同执行沙箱                                     | 明确不接入本轮运行面。需区分展示、PTC 执行与本地命令权限；新执行权限另列产品范围。                                                                                              |
| `cap-ptc` / PTC workflow           | [workflow-ptc][ptc]存在于 alpha.2，不在 rc.3 包组合                                                          | 明确不接入。可研究编排表达；Node VM 不是安全边界，文件策略不限制网络，总时限仍需调用方管理。须在既有隔离执行器中验证授权、取消、账本和计时，才讨论替代。                        |
| `cap-office` / Office Skill        | [skill-office][office]在 alpha.2；Allrice 已有 DOCX/XLSX/PPTX 交付依赖                                       | 可复用待验证。优先通过冻结 SkillBundle 引用可审查的 SOP/结构检查器，不默认开放 Python/Shell；需审许可证/依赖、文档结构、视觉/公式和交付权限。结构通过不证明排版或公式计算正确。 |
| `cap-landlock` / OS 文件限制       | rc.3 [sandbox-local][sandbox]有 Linux bwrap→Landlock 路线，旧源码也有相关后端                                | 可复用待验证。评估作为现有隔离内的附加限制；必须识别 partial enforcement、网络和内核共享边界，不能替换 VM/Bridge 授权。                                                         |
| `cap-hooks` / Hooks                | [hook-protocol][hooks]及 Codex/Claude bridge 是实际包名，不能假定存在通用 `dsh-hooks` 包                     | 明确不作为授权门禁接入。失败通常不阻断、exit 2 才阻断，且执行依赖 shell；可学习事件扩展设计，Allrice 授权检查仍在 Broker 前。                                                   |
| `cap-completion-wakeup` / 连续唤醒 | [alpha.2][alpha-release]修正连续后台/一次性助手完成后的默认唤醒上限；不推定 rc.3 已有该修复                  | 可复用待验证。逐次结果都需同一授权父节点与 durable delivery ID；验证长协作、取消、重复结算和用量，才删旧唤醒包装。                                                              |

本表条目同样由 MET-154 负责本轮复核，MET-155 只承接被选中的能力模块/Skill 封装；撤销实验即恢复原冻结配置，不删除正在使用的依赖或数据。新增执行面必须另行明确范围。

## 持续维护规则

测试阶段的能力展示原则：升级后默认展示已接入能力及值得复用的上游能力，提供现有配置和试用入口。两个后台共用 `packages/dsh-runtime-diff/capabilities.json`，每次升级同时更新版本对应的能力说明；已集成、上游待接入和仅前瞻版本已有的能力明确标注。展示不等待后续架构重构，实际命令和文件修改沿用现有审批。

1. 每次上游升级、适配新增/删除或源码补丁变更，都在同一 PR 更新有关条目；保留理由也要注明新复核日期与固定 SHA。
2. `pnpm dsh:verify` 检查每个 ledger ID 在此有入口；评审仍需核对内容，不能只补一个 ID。也必须审查 `patchedDependencies`，一个 ledger 条目可对应多个物理源码补丁，不能用条目数代替补丁清点。
3. 每条至少保留稳定 ID、Allrice 路径/原工单、上游包/源码 SHA、存在/启用差异、决策、权威边界、验收、退役条件、回退方式和实现 PR。退役记录保留，不抹掉历史。
4. 上游新版本的研究快照放在 `dsh-upgrades/`，从本页链接；机器发行文件只随实际兼容实现更新。历史日志夹具保持原字节，不用新版本重新生成来冒充兼容。
5. 不以“减少多少代码/节省多少 token”替代行为验收；有测量再填写收益。PR-2 已更新候选依赖及发行事实；PR-3 只删除一段重复转换，不减少 ledger 条目或物理补丁数量，不改变工具集合。

[met154]: https://linear.app/metasnowsky/issue/MET-154
[persistence]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/session/session-persistence-jsonl/README.md
[v0-validation]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/session/session-format-v0-to-v1/src/validation.ts
[repeat]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/guard/repeat-tool-reminder/README.md
[goal]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/goal/goal-round-driver/README.md
[subagent]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/subagent/subagent/src/index.ts
[team]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/experimental/agent-team/README.md
[old-team]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/experimental/agent-team/package.json
[presentation]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/core/agent-tool-presentation/README.md
[web]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/web/tool-web/README.md
[sdk]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/sdk/server/src/server.ts
[wire]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/sdk/protocol/src/types.ts
[cli]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/apps/cli/package.json
[connection]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/client/connection/src/client/index.ts
[compaction]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/compaction/compaction-basic/README.md
[plan]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/plan/plan-mode/README.md
[reference]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/context/session-reference/README.md
[ptc]: https://github.com/deepseek-ai/deepseek-harness/blob/00102833dfaee1da9f48a3a8eae9d34005a75218/packages/workflow/workflow-ptc/README.md
[office]: https://github.com/deepseek-ai/deepseek-harness/blob/00102833dfaee1da9f48a3a8eae9d34005a75218/packages/skill/skill-office/README.md
[sandbox]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/sandbox/sandbox-local/README.md
[hooks]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/hooks/hook-protocol/README.md
[alpha-release]: https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-alpha.2
[attachment-admission]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/attachment/attachment/src/index.ts
