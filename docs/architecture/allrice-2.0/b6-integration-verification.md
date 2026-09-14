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

## 必须保持的解释边界

助手输出文件的 hash、归属和存储完整性可以验证，但不代表模型内容或外部动作已经独立核实。UI 使用“关联工件”，输出标注 `model_proposal` / `independentlyVerified: false`。

存储 I/O 超时必须释放数据库锁；提交 ACK 未知不得因另一连接暂时读不到记录就删除可能已提交的字节。尚未确认结束的写入保留为待检查对象，不自动重放或宣称成功。已确定 callback 失败的清理只针对本次新建对象。

模型/命令/审批/浏览器开关和员工能力仍分别控制。通过测试不自动向 Snow、Drink 或其他真实租户开放助手或高权限功能；Boost、Teamwork、跨岗位 Handoff 不在本批实现范围。证书缺口及其余 P27 未测项不能由检查器、构建成功、M5 普通启动或另一条业务场景替代。
