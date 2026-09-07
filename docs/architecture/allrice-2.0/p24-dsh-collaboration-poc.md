# P24：固定 DSH 的协作、审批、取消与冷恢复 PoC

MET-121 / MET-108-A / B2 / S6。日期：2026-09-08。
只验证底层接口并确定 P25/P26 约束，不发布 Subagents、Boost、Teamwork 或 Handoff 产品。
研发、自审、自测由 Codex 负责，无 Gemini 开发门禁。批次合并与 Dev 证据另行登记。

## 决策与代码边界

**沿用单一 DSH Harness，采用原生 continuable 子助手服务；平台必须补齐持久授权和调度边界。**
可以进入 P25/P26 实现，不可以把 PoC 通过解释成助手已可供租户使用。

- 固定分发版本 `0.1.1-rc.2-b150a55`，插件 `0.1.1-rc.2`，上游提交
  `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`，MIT；来源见 `apps/worker/dsh/upstream.json`。
- `apps/worker/test/p24/poc.cordis.yml`、`runtime.mjs`、`fixture.ts` 是独立试验组合。
  仅用 loopback 合成 SSE 模型和合成工具输入；实际运行原生 Agent、Subagent、Approval、JSONL 服务。
  没有另写模型循环，也不调用真实模型凭证。
- 只新增三个固定版本 **devDependencies**：subagent、spawn-in-process、user-approval。
  `allrice-restricted.cordis.yml` 与生产 runtime 入口不变；回归断言禁止悄悄装配这些能力。
- 测试 host 是可信同进程实验驱动，不是可部署的租户 RPC API，也不是跨租户安全沙箱。
  本 PR 不增加数据库表、线上权限、默认工具、租户开关或 Bridge 安装包。

## 实测结论

| 场景              | 固定版本的实际行为                                                                                               | AllRice 必须承担的职责                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 新建委派          | `startContinuable` 返回稳定 childId 和 inbox messageId；新子会话无父聊天正文，记录父身份/深度；重复 childId 拒绝 | 建立平台 parent/root/child Run 与原生 ID 的持久映射，先登记再投递                               |
| followup          | 精确直接父身份校验；在同一子会话排队；不能由另一个父对象投递                                                     | 除原生对象校验，还要检查用户、租户、权限交集、generation、Worker 租约、根取消与预算             |
| report            | 只投递选定内容；`quiet` 不自行唤醒父模型；来源为 `subagent-report`                                               | 保存报告/结果收件箱，决定是否唤醒；不将报告当授权或完整父上下文                                 |
| settlement notice | 子任务正常结束会另外发送 `subagent-settled`，自动 followup/steer 唤醒父；quiet report 不关闭这条通知             | P25 必须治理结果入账与父唤醒；不能把 quiet report 当作整棵树的静默策略；已排空树只注入、不唤醒  |
| native approval   | 父配置为 ask，子仍持久化 `policy=never, source=delegation`；子请求返回 rejected，交互 answerer 未被调用          | 用独立的 proposal→平台精确审批→Broker 执行→结果协议，不能改成对子开放原生批准                   |
| 单个 interrupt    | 仅中断指定子助手当前回合，孙助手仍可运行                                                                         | 界面区分“中断一个助手”与“取消整项任务”                                                          |
| 整树 drain        | 子先于父释放；关闭该活根的新增委派/后续投递；无关树继续；迟到模型响应不唤醒已释放树                              | 先提交根取消意图，再排空 DSH/操作/进程；等待确认不能直接标已停止                                |
| 冷恢复            | 可从 JSONL 列出 continuable 子会话，不因列表查询启动；同 ID 显式 followup 恢复上下文和 never 策略                | 持久化平台所有权、版本和租约；不能仅凭原生 ID 或“可恢复”授权                                    |
| 已落盘的排队输入  | 原生 `agent/inbox/spliced` 保存待办；`sessions.flush` 后 SIGKILL，后续唤醒按 FIFO 采用，每条 user/message 一次   | 区分 inbox admission、durable checkpoint、step adoption，不重复重投已恢复待办                   |
| 未落盘的排队输入  | 将原生 batching window 调为 60 秒以稳定制造窗口；接收 ACK 后、flush 前 SIGKILL，该输入丢失                       | ACK 不是耐久保证；需要平台 outbox + 原生 messageId/checkpoint/adoption 证据，unknown 不盲目重放 |

默认 JSONL batching window 源码为 200 ms；60 秒仅是本 PoC 的故障实验配置，生产未改变。
这里的“落盘”证明进程 SIGKILL 后可恢复，不承诺磁盘掉电/文件系统灾难零损失。
一次成功委派、一次 root drain 或 `whenIdle()` 均不是业务完成凭证。
首次 CI 暴露了实验夹具把任意末尾 user 消息都当作子 proposal，以及将整树模型调用数固定为两次的错误假设。
修正为精确合成任务标识、单次 proposal 与实际 tool-result 采用证据；另外验证正常 settlement 唤醒父任务，
整树取消后不唤醒、无关树仍正常完成。未屏蔽原生通知，也未放松取消门禁。

## 真实平台审批联测

`packages/database/src/runtime-governed-bridge.integration.test.ts` 的四个 P24 用例：

1. 原生模型工具调用仅提交 proposal；子 native approval 实际为 rejected。
2. 可信测试适配器校验精确父子对象映射；从平台已知 Run/tenant/target/grant/baseline 生成绑定，
   不从模型参数取得授权。使用实际 P04 Policy、PostgreSQL 账本和审批记录。
3. 未批准时 Bridge 的真实 HTTP next 返回空、文件不存在；篡改 requestDigest 的批准被拒绝。
4. 精确批准消费一次，经 HTTP、真实 SQLite journal、实际文件写入返回成功证据。
   结果回到子工具响应和下一次原生模型请求；重复 poll 不重复执行。
5. 拒绝和派发前持久根取消均不写文件。已执行后再取消保留真实 succeeded 证据；
   排空原生树后迟到工具结果不再触发模型；重新创建 ledger 仍拒绝取消根的新操作。

此 adapter **不是拒绝后自动批准**：native 侧没有实际高权限工具，proposal 本身不产生业务动作；
只有独立的人类精确授权才能使平台执行器执行。所有实际动作继续受 P04 重检查。

实验暂把子 native ID 记入 operation.agentInstanceId，业务授权归属已知 root Run。
测试中的父子映射是进程内的可信夹具；它不是 P25 的持久 child Run/交付协议，不能用于上线。
本测试不会把 prompt tool-filter 当授权，也没有测试或宣称父子 OS 进程隔离。

## P25/P26 的最小接口与硬门禁

1. **持久身份**：复用 P01 RuntimeTaskRef，保存 root/parent/child Run、agentInstance、原生 Session/Message、
   generation/worker lease/fence、execution target/work copy、冻结配置和权限交集。
   预留 childId 再创建；失败有 provisioning 状态，重试不得新建第二个子助手。
2. **消息**：outbox 的幂等 inputId/contentDigest → native messageId → durableSeq → adoptedSeq；
   区分 accepted/durable/adopted/unknown。恢复时核对真实 inbox 和 user/message，
   已采用不重投、未证实不假装送达、损坏/未知版本 fail-closed。不能再说“原生 inbox 完全不持久化”。
3. **结果**：独立的 durable result/report inbox 和 deliveryId；父离线、已结束或根已取消时只入账不唤醒；
   结果接收、用户通知、父模型采用分别记证据，不能用一次 RPC 成功代替完成。
4. **审批**：子只能提出受约束动作/Changeset，平台冻结完整参数、scope、版本和基线；
   绑定精确审批和 operation attempt，批准/拒绝/过期/取消均持久化；凭证和危险工具不下放子上下文。
5. **取消/预算**：先持久 root cancel/tombstone 和共享预算，再 native drain、Broker cancel 与进程确认；
   原生 drain 的 admission cutoff 绑定**当前活对象**，不能代替跨 Worker/重启的取消权威。
   新投递/冷恢复/结果唤醒逐次检查租约、fence、根状态、深度、并发、累计子任务数和预算。
6. **产物**：分离写工作副本，复用 P06/P08 版本、反馈、Changeset 与精确落盘审批；
   不让两个助手直接竞争修改租户同一工作区。产物提交者/审查者/应用者分开显示。
7. **显示与验收**：P26 展示实际树、等待原因、审批、产物、取消确认、成本和恢复状态；
   P27 做租户端联合验收。Boost/Teamwork/正式 Handoff 不在此次基础助手开放范围。

## 复现与来源

```sh
pnpm exec vitest run apps/worker/test/p24/native.test.ts apps/worker/src/harness/dsh-runtime-profile.test.ts
ALLRICE_RUN_DB_INTEGRATION=1 ALLRICE_TEST_DATABASE_URL=postgresql://a123@localhost:5432/allrice_b2 pnpm exec vitest run packages/database/src/runtime-governed-bridge.integration.test.ts -t P24
```

本次分项实测：5 个原生进程用例、4 个实际 PG/HTTP/设备执行用例通过；profile 2 项通过（含 1 项既有测试）。
DSH 源码阅读依据为固定安装包 README、`lib/types` 和 `lib/index.js`，不是仅参考网页产品形态：

| npm 包（均 0.1.1-rc.2）                    | lib/index.js SHA-256                                             |
| ------------------------------------------ | ---------------------------------------------------------------- |
| @deepseek-ai/dsh-subagent                  | 555ab9189cc4baa7cd2b527099b932497310a6a609798a4d5cff30fa89349c5a |
| @deepseek-ai/dsh-subagent-spawn-in-process | 1dde2018b8f87f37800c2f2f86ea5f0b40773d0f22471d685f3615275b0f6af1 |
| @deepseek-ai/dsh-user-approval             | 935e79dd05fef47503c6b1b230c02380284f03dec0b2be98f71d8a60393ccb99 |

继续保留上游 MIT 许可，不复制另一套 OpenAI/Cline Agent Loop。
回滚只撤回试验文件和 devDependencies；无线上日志格式、权限或数据库迁移回滚。
整批测试、CI、合并和 Dev 发布以 B2 交付登记为准，不由本页单项通过推导。
