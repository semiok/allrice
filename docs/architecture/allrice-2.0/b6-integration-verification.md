# B6：候选集成与未完成门禁

2026-09-14。对应 MET-138～142，顺序与完成条件仍以 Linear 唯一执行总表为准。本页记录实际检查，**不是 B6、P27、RC 或 GA 完成声明，也不是合并/部署授权**。当前 main / Dev 仍为 B5 `57f3b5fd2acba034e9011231075c3e29b4503733`，Prod 未改。后续候选改变必须重新验证，不借用这里的旧结果。

## 第一轮整合

本轮源码 `b04e512d8173b2b7fb5fac9565f5a7844654444b`，检查时 tracked tree 干净。来自独立切片的实现包括 P14 可信更新候选、P25 助手账本/生产原生适配/精确命令提案/不可变输出、P26 工作台和下一任务偏好，以及 P28 发布材料检查器。

- 全仓 Prettier、ESLint、TypeScript 检查通过。
- 8 文件 **147 项真实 PostgreSQL / 原生 DSH 集成测试通过，0 skipped**：权限 58、输出 35、偏好 5、生命周期 12、命令提案 22、反证 11、原生 3、生产 controller 1。使用 `allrice_b2` 中独立随机 schema、合成身份和独立存储；没有修改真实租户。原生测试的 HTTP 模型是可控替身，不是计费模型成功证据。
- 普通整仓测试 **1900 passed / 2 failed / 683 skipped**，不能写成全绿。两项失败是旧测试对默认工具数以及 production 中不存在 subagent 依赖的断言；需在保留默认关闭和原生受控入口约束的前提下更新并重跑。P25 新缓存 token / 撤权取消审查修复不由本轮覆盖。
- P26 之前独立 Chrome + built Next + 真实 PostgreSQL 页面验收通过：桌面/390px、刷新与会话隔离、停止请求不等于执行端停止、未发布模式禁用、关闭开关后历史仍可读。它使用合成持久历史，不替代实际模型委派；最终候选仍需复跑。

私有原始报告为整合工作树 `.local/b6-assistant-real-pg-native-tests.json`（SHA-256 `c52a6527488d2b15db363f8159bf52a3c14f1866d9d1a08f69c14dc1d8e679c7`）和 `.local/b6-full-tests.json`（`bf27eb6be2319d4e58d2a5592ee63cdfea701ad35e950a14975ab5461de4bd2e`）。这些不是 P28 的正式 47 项候选收据。

## M5 原生补测

P14 独立提交 `7e8a0dfcf20d3e7d2623bb190e717f6923e50de3` 的 ARM 开发包，ZIP SHA-256 `b539b461be1bacc97ef92418cd352b3ce1b10eb205089ea1b30a3020620a4a6f`，已传至实际 M5，远端全量 hash 一致。运行环境为原生 arm64 / macOS `26.6.2`；Node 22.23.2 仅复制到新临时目录用作测试驱动，不安装或覆盖系统 Node。

实际 `bridge-desktop-core.mjs` 通过：SEA 启动、暂停后停止轮询、暂停期间重复实例拒绝、测试工作区和身份保留、恢复/停止、EOF 与 owner 重取、AppKit 宿主启动/状态视图渲染、重复宿主退出、宿主退出后 Core owner 释放。仅合成 loopback HTTP、独立配置与合成 token；没有 `--fresh`、Keychain 写入、替换已装 Bridge 或改真实配对。没有将 AppKit 渲染写成 AX 菜单点击验收。

本地保留 `/tmp/allrice-b6-m5-tUxgwI/result.json`（`5fb981dc6a6063be8b7acf666ee5b65b009b2bb7088cd5d1ec113bc5b034679d`）和 `native-status-view.png`（`b15fd914905e264026d7d53d79b178c657e404b0c61fbfa1134073c8c90826fb`）；远端仅本次启动的测试进程已退出，原安装和用户数据不变。包沿用开发版本 `0.5.0-dev.1`，不是最终分发版本。

Intel 与 M5 当前可用 Developer ID Application 身份数量均为 0；只检查身份数量，没有读取/导出私钥。可信更新源码 trust 保持 `null`，不会访问更新服务器或安装包。正式签名、公证、可信 bootstrap、真实更新/中断恢复/回滚、最终双平台包与联合发布验收仍未完成。P14 首轮并行 journal 锁测试异常仍按其文档保留；本轮未复现不等于已确定根因。

同一 ARM 包另完成 saved-opt-in 路径：不用环境变量替代既有设置，独立配置重开后实际宿主/Core 启动、视图、排他 owner 和退出均通过。报告 `/tmp/allrice-b6-m5-tUxgwI/saved-opt-in-result.json`，SHA-256 `906bf1f52c267ad252b82ac4c3e85d8150311ed52cd9e7da333e52c09c997be7`。它不证明正式签名、Keychain 迁移或可信更新。用户明确回复没有 Apple Developer 账号/Developer ID 证书；不代为注册付费账号，不拿 ad-hoc 开发包替代该门禁。

## 第二轮修复与分项复验（尚非最终候选）

组合源码 `0cddf61b0734a2a5d7db9bf6530a777457f0eefa` 已集成原生助手产物发布、父级采纳、缓存 Token、撤权停止和保守冷恢复接线。该轮全仓类型检查、ESLint、Prettier 均通过。完整普通测试为 **1907 passed / 7 failed / 689 skipped**；第一轮两项旧基线断言已修正并通过，7 项失败涉及 Bridge desktop ready-condition 与 update monitor health deadline。报告 `.local/b6-full-tests-0cddf61.json`，SHA-256 `3507d318e0cc3c98917fbddd9cc0328d8e20c4dbe60b164565529584ec6a6b44`。

降低并发后，在组合 `3dae9f3` 对原失败的 `desktop-controller.test.ts`、`update-installer.test.ts` 完整文件复测，**47 passed / 0 failed / 1 skipped**。报告 `.local/b6-p14-timing-recheck-3dae9f3.json`，SHA-256 `7f7a64e52b21fb7dd7e8875975e0a81785c00f0c1365b59f0fa0fbfb7c5bf1c9`。机器当时同时运行其他测试和类型检查；这一复测不能单独证明负载是全部失败的根因，更不能替代最终完整回归。没有因此放宽产品超时。

P14 Draft #62 的首轮 CI 在无构建产物的 checkout 上发现独立子进程缺少源码 TSX 映射；提交 `4eb2a6e66ce866aa986227e28114749bd12e178d` 为测试设置显式源码映射和有界子进程等待。独立工作树确认 `packages/contracts/dist/index.js` 不存在时，quiescence + journal **17/17** 通过，已推送 CI。P28 Draft #63 首轮 CI 通过。P25 #64 和 P26 #65 均为 Draft；P26 以 P25 分支为 base 保持独立差异，不能绕过本批门禁单独合入 main。

后续读审仍在修复主任务最终状态与全树用量传播、纯查询 child 来源审计、实际 native → P04 approve/reject → receipt 证据。真实 provider smoke 仅准备脚本及预检，尚未实际调用。上述分项测试不构成它们的通过证明。

## 第三轮常规回归与工作台复验

组合 `2de712cb704a79dc96569bd817ace4ca7b06c588` 已包含未知费用/Token 的持久化、晚到回执拒绝降账、全树用量向 Worker 传播、partial 非整项成功，以及普通助手异常不写成已知零费用。该 SHA 的全仓 Prettier、ESLint、TypeScript 通过；`pnpm install --frozen-lockfile --offline` 与 `pnpm dsh:verify` 通过。没有批准依赖安装脚本，distribution 清单检查不等于所有安装字节的 SRI 证明。

该 SHA 的完整普通测试以 `--maxWorkers=1` 执行，**1930 passed / 0 failed / 721 skipped**，299 个测试文件没有失败。报告 `.local/b6-full-tests-2de712c.json`，SHA-256 `e0b6e5f043cc9d350cba18181a0396f4157961872d4ee8477a9a9f09adb768ac`。跳过项需各自真实环境门禁，不能计为通过；该成功不删除前两轮失败，也不覆盖随后修改。

在 `1f518cf7da955496d6660c11ce1b1ab1ec89eda6`（新增查询 partial 断言和范围文档，尚无后续撤权停流修复）完成 Web 及依赖构建，BUILD_ID `Y76yol23DZWXi_-kG5IO-`；真实独立 Chrome + Next + 随机 PG schema 工作台再次通过。桌面/窄屏、折叠警告、纯文本防注入、未发布模式禁用、下一任务偏好不改现任务、停止请求不冒充执行停止、刷新/Session 隔离、关闭助手开关后历史可读及仍可请求取消均通过，Page/Console/HTTP 错误为 0。使用合成持久历史，没有 Worker/provider 或个人浏览器数据。

页面证据 `/tmp/allrice-p26-ui-Lk1axb/evidence/checks.json`（SHA-256 `34582050505d329420d9541fd187c5a5a1c879afb6e21d24f3961812c1ac1950`）、`desktop.png`（`7a87a7caca7a20e138e38a669cbd8ef3485b5f093f8cfa28f12525e6416dca96`）、`narrow.png`（`798352d43a682b673adb743a671d0a5613498c494d4661b92ac1e1c4a889ccaf`）；桌面截图由主开发实际查看。私有 Next/Chrome 已退出，随机测试 schema 清理，证据保留；这不是现有 Dev 部署。

五个独立 Draft 为 P14 #62、P25 #64、P26 #65、P28 #63、P27 #66。P14 `4eb2a6e` CI run `34810478053`、P28 `7e6132e` CI run `34809777947` 通过。P25/P26 首次 CI 的旧合成提案重复和合法取消缺 Origin 已修复，跨站取消拒绝测试保留；后续最终 head 仍需 CI 复验。所有 PR 保持 Draft，main/Dev 未变。

### 第三轮当时仍在补验的边界

- 在途模型遇到非 membership 的 policy/employee/assignment/flag 撤权，不能只阻止下一次工具准入；需实际关闭当前流且不伪造执行停止回执。该窄修及正常完成竞争回归正在进行，上述整仓结果不含此修复。
- 真实 provider 基础助手脚本必须断言 adapter 返回的全树用量/完成状态与数据库一致，不能只查数据库而漏掉 Worker 返回字段；部分 fixture 初始化失败也不能误报清理完成。最终候选需包含这些验收修正。
- 助手无权威价格/费用核对闭环时费用为 NULL、cache 拆分未知，月度配额按未知拒绝放行。**真实租户助手启用仍受阻**，不能以已知 0 或放宽配额解决。direct adapter 的一次真实模型 smoke 不经过完整 Worker route/quota，因此不能证明真实租户连续调用可用。
- Apple Developer / Developer ID 条件仍缺，正式签名、公证、可信更新回退和 P27 全部联合场景仍未验收。不能将脚本或普通开发包测试充当这些证据。

## 第四轮：撤权回归、真实模型失败与预算阻断

组合 `faec3b7` 纳入在途 authority 撤销停流及正常结束竞争修复。在独立 `allrice_b2` 随机 schema 中，14 文件的真实 PostgreSQL / 原生 DSH 相关测试为 **284 passed / 0 failed / 4 skipped**。报告 `.local/b6-real-pg-native-faec3b7.json`，SHA-256 `54d6f372eb4f048bd9491e66781c90389743d70888193ed96971a31a504d08ef`。模型 HTTP 为合成服务；4 项实际 VM/设备开关未开启，不能计作通过。

组合 `1507ff0639d3ea2d33aa7df396b7aa8822eae6c4` 增加 P27 返回值全树核对及部分 fixture 初始化清理证明。完整普通测试 **1942 passed / 0 failed / 731 skipped**，302 个文件；报告 `.local/b6-full-tests-1507ff0.json`，SHA-256 `ed3161d8760614bb90ee90e4879cdff0a9a517fa36422842ca0ee7c691090aa6`。P27 帮助测试首次命令误把故障清理测试所需的数据库环境变量传给要求干净环境的正常 fixture 测试，得到 22 passed / 1 failed；移除两项继承的数据库变量后，该正常 fixture 测试单独 **1/1 通过**，没有放宽隔离检查。

### 首次真实 provider 验收：失败，未重试

在上述干净 `1507ff0` 候选上，仅执行一次授权的真实 Codex smoke。使用独立合成组织、随机 schema、独立存储与原生运行目录，经正常受限 DSH/provider 通道；不启用真实租户、不修改 Dev 部署。实际启动父级和两个助手，但约 9.8 秒后执行失败，**不算 P27 通过**。原记录只保留固定分类 `p27_external_or_runtime_failure`，不据此追认未捕获的原始异常。

最终失败收据 `.local/p27-assistants-cb010a94-3d03-4b2d-bab1-0e180e75572a/03.json`，SHA-256 `b1f7ce7acc28608800a6b0986356daeb02b71d0668545f1fcaab736193b2857c`。本次拥有的原生 client 已退出、执行已收束、随机 schema/存储/连接/临时运行目录清理均有证明；未知消耗未改成零。收据不包含模型原文、思考文本或密钥。

当时输出总预算为 12000，父级已花费 246，两个助手各保留 4000，因此下一次父级再申请固定 4000 会达到 12246 并被拒绝。独立真实 PG 三项测试在 `c694dfe` 精确复现该条件，包括失败时整笔不变、并发边界和未知保留不被释放；这是已证明的预算缺陷，不能据此声称已还原原失败的全部原因。

固定 DSH 的请求在 `llm/stream` 前已经 prepare/freeze；不能在那里降低 `maxTokens`，也不能只降低账本保留却发送原上限。固定 `pi-ai` Codex request builder 未序列化 `maxTokens` / `max_output_tokens`，这只是当前 SDK 的已验证限制，**不是关于服务端支持范围的断言**。当前修复方向是支持的 `agent/request` 预分配、prepare 后同一 call ID 原子 dispatch，并按服务端冻结 provider 能力拒绝不可证明的助手输出边界。不得加大总预算掩盖问题、修改 node_modules、放宽配额或建立第二套循环；普通未启用助手的 Codex 聊天须保持不变。

`4b364b9` 增加仅验收脚本使用的白名单错误分类器，拒绝 getter/Proxy 等动态取值，不输出原始消息/堆栈/URL/header。它不补造第一次失败丢失的信息。上述成功回归均**不覆盖尚在开发的两阶段分配和 provider 准入修复**，也不解决权威定价/费用核对与 Apple 签名门禁。

## 第五轮：两阶段修复与新协议门禁回归

组合 `8716b77e8fa872d91c634550d826a17e21f98434` 包含冻结前动态 grant / 同 call 一次性派发、0095 expand 迁移、服务端协议预检、P27 预检阻断和独立 Worker 账务反证。全仓格式、ESLint、TypeScript 与 Worker 及依赖构建通过。

- 18 文件真实 PG / native 合成模型整组 **302 passed / 0 failed / 4 skipped**。包括满额与同 call 并发、跨 child/scope/generation/fence/lease、摘要不符、未知预留保持、预检已知零账务，以及既有权限/取消/输出/P04 链。报告 `.local/b6-real-pg-two-stage.json`，SHA-256 `fafc3d7393e5fbc6dc04a42d399ebdd8ea8639e4236f2300b835c22247edac2d`。4 项设备条件跳过不计通过；没有真实 provider 请求。
- 307 文件完整常规测试 **1975 passed / 0 failed / 747 skipped**。报告 `.local/b6-full-tests-8716b77.json`，SHA-256 `5625c3092e5e279597c954644eefd9c20f74a4c48d0815c7e88fd8714896f1ea`。这些计数不含随后 P28 材料修正或前端可用性提示改动，不能当作新候选完整验收。
- `fefffad` 的 P27 helper / dummy 测试 **46/46**，明确 roots 的脚本 TypeScript 检查为 0 diagnostics。实际 `--preflight` 返回 `eligible:false`；对同 SHA 提供执行授权但不提供 platform 路径，`--execute` 在任何凭据元数据、DB、宿主或 fixture 创建之前返回 `blocked_before_execution` / 退出 1。它验证拒绝路径，**不是第二次真实模型执行，也不是成功验收**。

固定 Codex SDK 的助手输出上限仍未证明，生产只拒绝该助手路径，不关闭普通 Codex。Gemini 仅有原生 SDK 到 loopback HTTP 的输出字段与合成用量证据，不冒称真实 Google 任务或新的动态子任务全链通过。无权威费用/缓存核对的真实租户启用门禁继续保留。

P25 的 CI 新增显式真实 PostgreSQL / native 合成模型步骤，避免只跑常规条件跳过。P28 增加 0095 清单/摘要、prepared 非派发证明、未知 hold 与 NULL 费用的恢复保存要求；检查器不执行迁移或恢复。main 远端与 Dev active-release 已再次核对仍为 B5 `57f3b5fd2acba034e9011231075c3e29b4503733` / `YmBpsav9R6_mfJmIob03N`，没有本批部署或启用。

## 结果、权限与发布边界

助手输出文件的 hash、归属和存储完整性可以验证，但不代表模型内容或外部动作已经独立核实。UI 使用“关联工件”，输出标注 `model_proposal` / `independentlyVerified: false`。

存储 I/O 超时必须释放数据库锁；提交 ACK 未知不得因另一连接暂时读不到记录就删除可能已提交的字节。尚未确认结束的写入保留为待检查对象，不自动重放或宣称成功。已确定 callback 失败的清理只针对本次新建对象。

模型/命令/审批/浏览器开关和员工能力仍分别控制。通过测试不自动向 Snow、Drink 或其他真实租户开放助手或高权限功能；Boost、Teamwork、跨岗位 Handoff 不在本批实现范围。证书缺口及其余 P27 未测项不能由检查器、构建成功、M5 普通启动或另一条业务场景替代。
