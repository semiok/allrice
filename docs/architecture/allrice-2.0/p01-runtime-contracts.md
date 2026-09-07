# P01：公共运行与交互契约

> [MET-110](https://linear.app/metasnowsky/issue/MET-110) / S0 / R2，升级自 [P00 八项语义](contracts.md)。
> 本 PR 是共享 Zod schema、纯函数、回归测试和映射说明，不是新的运行能力发布。

## 给产品经理的说明

P00明确了“这些概念是什么意思”；P01把它们写成前端、服务端、Worker 和 Bridge 后续能共同校验的数据格式。例如，收到“取消请求”只能显示正在取消，不能显示已经停止；用户认可一个计划，也不能被解释成允许写入文件。

代码位于 [packages/contracts/src/runtime-v2](../../../packages/contracts/src/runtime-v2/index.ts)。这些定义尚未接入生产请求或执行端，因此本次不会改变页面、旧 Session 或 Bridge，也不会增加 Shell、云计算、数据出端或助手权限。后续实现必须调用这些校验，并补数据库事务、身份解析、真实执行与失败恢复测试，才能宣称相应功能已完成。

排期与 PR 依赖仍以 [执行总表](https://linear.app/metasnowsky/document/allrice-20-执行总表阶段依赖pr-与验收门禁-df09b0b1e681) 为唯一权威。P01不提前实现P02～P28，也不把契约通过算作2.0 GA验收。

## 版本与已有对象映射

| P01 定义                      | 来源及边界                                                                                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RuntimeTaskRef`              | 引用现有 `Run.id`；`rootRunId/parentRunId` 预留108关系，不创建另一张任务账本或启动子助手。`chatSessionId` 是产品聊天 Session，可为空；**不是认证 `RequestContext.sessionId`**。                |
| `frozenConfiguration`         | 引用已入队 Run 的员工版本与配置摘要，不复制员工定义，不热改旧 Run。无员工的执行引用可为空；摘要不可省略。完整快照继续由原 Run 输入及员工/模型模块负责。                                        |
| `RuntimeScope`                | organization/workspace 必需，Project可空。校验实际对象归属必须来自服务端可信查询；`matchesRuntimeScope` 仅比较，不能授予成员权限。                                                             |
| `RuntimeExecutionScope`       | 引用现有 ExecutionTarget 类型；Bridge须有device，云目标没有虚构device。grant版本、scope摘要、work copy单独标识。本地绝对路径不进入此公开对象。现有 ExecutionTarget 无须新增 Run/Session 字段。 |
| `RuntimeContentRef/DataScope` | 引用已有 Artifact、StorageObject、DeliverableVersion；交付版本保留series/object/version/checksum。数据来源、用途、去向及出端授权引用分开，不因本地执行而隐去模型上下文出端。                   |
| `RuntimeActionBinding`        | 绑定执行主体、冻结政策引用、Run、operation/attempt、target/grant/work copy、动作/输入摘要、数据范围和内容基线。它是审批的比较对象，**不是权限令牌**。                                          |
| `RuntimeAttemptRef`           | operation ID是逻辑动作，attempt ID/正整数编号是一次尝试，generation和单调fence区分执行权。不是简单复制可从0开始的Job.attempt，也不公开可消费的JobLease.token。                                 |
| `RuntimeOperationSnapshot`    | 一次动作尝试的状态投影；step、agent instance、process、Run分别引用，不混为一个状态。幂等ID只是声明，P03仍需持久唯一约束。                                                                      |
| 交互与receipt                 | 复用原Ask User正文与审批ID，新增严格类型和生效依据；不是另一套审批消费账本。完整Review/Changeset存储留P06。                                                                                    |
| `RuntimeUsageObservation`     | 有来源和范围的观测，不是账单。预留/花费/结算、实测/估计/未知、增量/累计分别标记，不提供自动求和函数。                                                                                          |

产品2.0目录下的契约初版为 `contractVersion: 1`，operation事件还包含独立 `family: allrice.runtime.operation`。**没有**把旧 RunEvent `schemaVersion:1`、ChatFlow `schemaVersion:3` 或 Bridge v1/v2改成一个所谓“统一版本2”。旧包版本和依赖锁文件不变。

旧 Bridge 客户端直接广播现有能力枚举，因此本 PR 不向该枚举添加尚未实现的能力。也不修改旧Run/Job状态、SSE事件类型、DSH Profile、已有API或默认Feature Flag。

## 信任与授权前置条件

所有schema拒绝未知字段、非法身份/版本/计数；字段结构正确不等于可信。P03/P04及各领域适配器必须：

1. 从登录态/设备认证、Run冻结快照和数据库记录建立可信作用域与执行主体。浏览器自报组织、actor、target、摘要或“证据”不能成为事实源。
2. 按实际对象继续校验owner、visibility、成员关系、Project/Workspace及内容版本归属；引用UUID或同一scope比较不能替代这些查询。父根链还需防环与租户/预算核验，schema只能检查对象内的直接自引用。
3. grant、work copy、device、target、数据出端授权及政策摘要必须解析到同一获准执行范围。记录中的id一致不证明设备当前在线、目录仍在或本地路径安全。
4. 接收及执行前重新检查撤销、强禁令、有效期和精确绑定；在事务中消费审批并建立attempt/fence。纯匹配函数不会消费批准，也不具有防并发重用能力。
5. 完整命令规范化留P04/P05：程序、argv、工作目录、有效环境、网络、工具链与预算分别摘要绑定。环境中秘密使用凭证引用/版本，不把秘密原值或可逆日志写入绑定；摘要本身也不是日志脱敏器。输入或有效约束变化就必须重新批准。

`RuntimeScope`不是新增公开资源权限模型。已有ResourceRef/Storage/Artifact所有权保持原样；长期资源不需要虚构Session或Run来满足新引用。

## 动作、取消和未知结果

`planned → ready → dispatched → running` 描述调度事实，不代表每一阶段都获准执行。等待用户/设备/依赖只用于派发前的准备；已派发后因失联无法确认结果，必须进入`unknown`，不能退回ready重新发送。

- `operation.transport_ack`不改变执行状态，尤其不代表开始、完成或停止。
- `cancel_requested`保存意图；此后即使收到ACK，仍不能显示“已停止”。
- `cancelRequestId`独立保留取消意图；未知状态下仍可请求取消，状态继续保持unknown。取消后/失联后迟到的同attempt启动回执只能补充process关联，不清除取消或未知状态；多条不确定性事实不阻断后续核实。
- `operation.stopped`需要该attempt关联的证据。无副作用可为canceled；已发生部分副作用显示partial，不伪装成完整回滚。
- 成功/失败/部分完成需要真实结果引用。失败也可能已经发生副作用；不能把failed自动解释为“可安全重试”。
- 取消与完成竞争时，匹配的完成事实可以得到succeeded；不把已经成功的动作伪报取消。
- `unknown`只能由对应尝试的已核实结果/停止事实结束，不存在“租约过期自动重排”转移，也不会自动换为云目标。
- 终态不允许重新running。恢复执行、新attempt、文件恢复和继续Session由后续流程另行核验，UI刷新不产生动作。

纯投影函数验证状态边界，不验证操作系统证据真假。operation结束不等于整个Run成功；启动dev server的工具返回也不证明readiness、浏览器可达或整个进程树已停止。进程与根任务的实际管理仍属后续切片。

## 事件重放与兼容接入

`RuntimeOperationEvent`按operation attempt拥有从0起的连续序号，关联任务、冻结配置、attempt/fence及执行范围。它**不是旧RunEvent中的新type**，也没有接入SSE/WSS。

`replayRuntimeOperationEvents`只重放从planned初始投影开始的完整前缀，单次最多10,000条；不是无界在线缓存或增量cursor接口：

- 同event ID、同规范化内容：精确重投，只应用一次。
- 同ID内容变更、同序号不同ID：冲突并停止；不“最后一条覆盖”。
- 序号有缺口或乱序：在缺口处停止，保留此前有效投影和nextSequence；不能排序掩盖缺失。调用方取得完整权威前缀后重新重放。
- task、冻结配置、operation、attempt/fence、执行范围错配：不推进当前投影。迟到结果须另存待核实，不能凭receipt覆盖新attempt。
- 未知版本/类型、已知类型的畸形payload：明确unsupported/invalid，不忽略后继续推进权限或状态。
- 已终结旧Run的迟到进程/动作证据，不可通过新函数非法追加到旧RunEvent序列。P03需采用关联operation/evidence存储与对应读取接口；旧Run生命周期不被重新打开。

后续适配器需要数据库唯一键、事务顺序、来源认证、持久回放查询、速率/大小限制和旧客户端协商/降级。P01无网络推送、凭证消费或外部IO；函数返回成功不表示“设备恰好执行一次”。

## 交互与计量

Ask User、计划认可、版本反馈、动作批准采用不同判别类型。新输入区分补充当前turn、后续排队、请求中断后调整；已收到/排队与被DSH实际采用要有不同receipt，采用必须关联执行证据。问题回答与计划认可不能用于动作批准匹配；旧版本认可也不能继承到新内容。

Usage的observation ID标识报告，accounting ID标识同一计量项；累计计量窗口重置必须换window ID。相同累计快照、reserved/spent/settled阶段及包含子级的聚合值不能直接相加。未知amount必须为null而不是0；实测与估算显式分开。成本为注明币种的整数百万分之一主币单位；这只是精度单位，不做汇率、计费或预算扣减。来源选择、去重、根账本与结算留P03及执行适配器。

## 测试与后续边界

本 PR 新测试直接调用共享schema和纯函数：

- [身份/操作/事件测试](../../../packages/contracts/src/runtime-v2/runtime-v2.test.ts)：可信scope比较、目标/内容引用、全状态对、ACK/取消/unknown、结果核实、重复/冲突/乱序/未知事件、fencing及重放边界。
- [交互测试](../../../packages/contracts/src/runtime-v2/interactions.test.ts)：类型分离、精确绑定、到期/撤销/已消费快照拒绝、typed input生效位置。
- [计量测试](../../../packages/contracts/src/runtime-v2/usage.test.ts)：未知/估计/实测、单位/范围/时间及数字合法性。
- [旧契约回归](../../../packages/contracts/src/runtime-v2/compatibility.test.ts)：现有Bridge能力与版本、Run/Job事件与状态、ChatFlow和Ask User默认行为保持不变。

上述覆盖P00 A01～A07、A11/A12的部分契约要求；不表示原合成场景全部端到端通过。[P00 fixtures](fixtures/p00-contract-cases.json)继续保持`design_only_not_executed`。路径软链接竞争、租户实际授权、并发批准消费、断网恢复、进程停止、根预算、浏览器与真实用户交付要在各自后续PR测试，不能用此次schema解析代替。

本地验证命令：

```sh
pnpm exec vitest run packages/contracts/src/runtime-v2
node docs/architecture/allrice-2.0/validate.mjs
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

回滚仅撤销新增契约导出与实现/测试/文档；本 PR 无数据库迁移、启动参数变化、已消费审批或外部副作用需要回滚。不合并、不部署、不启用下一阶段权限；后续兼容接入仍须单独PR和真实验证记录。
