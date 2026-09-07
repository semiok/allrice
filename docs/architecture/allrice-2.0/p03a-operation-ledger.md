# P03-a：共享操作账本、预算与取消协议

> MET-112 / P03-a / B1。接续 [P01 契约](p01-runtime-contracts.md)。
> 这是数据库和授权接入底座，不是新 Runner、Shell、Cloud Runner 或助手已开放。

## 产品经理先看这里

过去“发出命令”“命令真的执行”“收到执行结果”容易被当成同一件事。本次把它们拆成 PostgreSQL 中持久、可核对的事实。网络断开不代表失败，收到 HTTP 响应不代表任务完成，用户点取消也不代表电脑中的进程已经停止。

同一根任务下的云端、本地以及未来助手操作可以共用预算和取消意图。数据库串行处理额度预留：两个 Worker 不能同时把最后一份额度花两次。确实不知道结果或用量时保留预留，不拿未知数据当零费用。

没有新页面、没有新执行权限、没有额外 Agent Loop。只有经过后续受信服务适配器接通的操作才进入新账本；旧 Session、RunEvent、Bridge 队列继续兼容。本 PR 不把既有队列中的历史动作自动搬进新表。

## 代码与数据

- [数据库模块](../../../packages/database/src/runtime-ledger/index.ts)：类型、事务、接入函数。
- [增量迁移 0073](../../../packages/database/migrations/0073_runtime_operation_ledger.sql)：只增加表与索引；不改旧表状态、默认权限或旧协议。
- [真实 PostgreSQL 测试](../../../packages/database/src/runtime-ledger/ledger.integration.test.ts)：独立 schema、完整迁移、并发和重启连接验证。
- [摘要纯测试](../../../packages/database/src/runtime-ledger/ledger.test.ts)：确定性 JSON 指纹，不包含命令执行。

| 表                                   | 责任                                                 | 不是                        |
| ------------------------------------ | ---------------------------------------------------- | --------------------------- |
| `allrice_runtime_roots`              | 引用现有根 Run，持久截止时间、取消请求与原因         | 第二个任务账本或新的 Run    |
| `allrice_runtime_run_links`          | 同一根任务已准入 Run 的不可变父子关联                | 启动助手的 API              |
| `allrice_runtime_budgets`            | 各计量维度容量、未结算预留、已确认花费和唯一权威来源 | 简单把父子用量相加的账单    |
| `allrice_runtime_operations`         | 精确输入绑定、首次 attempt/fence、状态、租约摘要     | 可重新排队的任意 Shell 命令 |
| `allrice_runtime_operation_events`   | 每 operation 从 0 开始的权威连续事件序列             | 已终结 Run 的新 RunEvent    |
| `allrice_runtime_operation_receipts` | 去重、迟到或冲突的已认证回执与证据                   | 来自浏览器的执行授权        |
| `allrice_runtime_reservations`       | 每动作每维度的预留及一次正式结算                     | 将重投或估算当成真实收费    |

操作仍通过复合外键绑定现有 organization / workspace / Run / ExecutionTarget。Project 作用域也必须匹配。父子链只能在既有父节点之后登记；根和父关系不能后改为另一条链。真正的成员权限、owner、冻结内容和数据出端授权还要由 P04/后续适配器在事务中解析，不由 UUID 相等推导权限。

## 接入与锁顺序

`createRuntimeOperationLedger({ database, admission })` 必须提供受信任的 `admission` 回调；没有回调直接拒绝。此模块是服务端数据层，**不是公开 HTTP 权限边界**。

1. 所有操作先锁根预算行，再锁 operation 行。
2. 校验现有 Run 和 target 的组织/工作区归属与适用存活状态。
3. `admission({ transaction, binding, phase, now })` 使用同一个 PostgreSQL 事务锁当前政策、grant 和审批记录。
4. 完成预留、审批消费、租约和事件/投影写入后一起提交。任一步失败全部回滚。

`phase=create` 可返回 `{ status: 'waiting_user' }`，建立等待批准状态，不能消费批准。`dispatch` 必须重新核对当前政策并在同一事务中消费精确审批；仍待批准即拒绝派发。`heartbeat` 用于真正开始前与续租时重新核对撤销/禁令，不能重复消费审批。语义校验和真正绑定解析必须由适配器实现，不能传入空回调作为生产默认值。

锁等待和回调耗时不能延长既定许可。账本在回调后、提交前重新读取数据库时钟检查根截止时间和租约；P04还须在自己的政策/审批锁取得后检查实际时钟，不能只用回调开始时的 `now` 判断审批有效期。

事件、预留、回执和租约写入也可能被锁阻塞，因此账本在最后一次写入后再次调用准入：create 重复 create 并要求等待状态一致；dispatch/start/heartbeat 使用 heartbeat 只复核已消费授权，不再次消费。随后再检查数据库当前时间及根截止时间/租约。续租同时要求旧租约此时尚未到期，不能靠新过期时间复活已经失效的租约。这些阶段的回调必须可重复；不允许在 create/heartbeat 中消费批准或触发外部副作用。

回调内部读取操作输入必须使用传入的 `transaction`。不要调用另开事务的 `readOperationInput()`，否则会等待自己持有的根锁。`create` 尚未插入 operation 行，输入必须来自当前受信 Broker 的规范化请求；`dispatch` / `heartbeat` 可以读该事务已经锁定的 operation 行。Bridge payload 使用解析后包含默认值的精确 JSON，再按递归 codepoint 键排序计算 SHA-256，须与 `binding.inputDigest` 相等。

`createRoot` 只供已经认证并决定预算的服务端编排器使用，不是用户自报更大额度的 API。它校验实际 Run/租户引用和不可变配置，但不负责判断某个用户是否有设预算权。`read*`、`cancelRoot` 同样要求上游已有受信身份与访问权。P03-b 的设备路由必须用设备凭证解析 scope，并核对 device，不能直接转发浏览器给的组织、用户或目标。

## 公共接口

| 接口                                                            | 语义与门禁                                                                         |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `createRoot`                                                    | 登记根 Run 与不可变预算/截止时间；重复相同请求幂等，不允许“重试时加预算”           |
| `createOperation`                                               | 首次 attempt=1、fence=1；全部配置预算维度必须预留；同幂等键相同内容只保留一份      |
| `dispatch` / `claimNextBridgeOperation`                         | 独占派发，当前政策及精确审批同事务；不会重新领取已派发或 unknown 操作              |
| `startOperation`                                                | 执行端持久记录收到命令后，请求一次开始准入；当前租约、取消与政策重新校验           |
| `heartbeat`                                                     | 只延长仍有效且仍允许运行的租约，不复活过期、取消或 unknown 尝试                    |
| `recordReceipt`                                                 | 按 receipt ID 和精确内容防重；服务端为新事实分配权威事件序号；迟到证据不借机重派发 |
| `expireLeases`                                                  | 过期在途动作变 unknown，根到期同时记录全树取消意图；不宣称进程已经停止             |
| `cancelRoot`                                                    | 根和所有非终态操作持久记录同一取消请求，阻止新准入；已完成动作不被改写成取消       |
| `settleUsage`                                                   | 仅接收终态动作的权威来源、实测、完整累计结算；精确重复不再计费                     |
| `readOperation*` / `readEvents` / `readReceipts` / `readBudget` | 读取有范围约束的持久快照、输入、证据、事件及已确认/待核实计量                      |

`startOperation` 第一次准入提交后返回 `mayExecute=true`；相同请求重投返回 `false`，不是第二张执行许可证。若响应丢失，设备不知道是否获得开始许可，必须按 P03-b 日志协议报告不确定性，不能再次请求后猜测执行。这个协议宁可留下待核实工作，也不冒充网络恰好一次执行。

执行端回执与服务端事件分别拥有序号。回执只能报告 started/ACK/uncertain/outcome/stopped，不能要求服务端 ready/dispatched/授权。回执 token 只保存哈希在服务端；不会出现在公共快照或事件里。输入和证据有 512 KB 序列化上限；大产物应在独立存储中保存引用，上游负责认证来源、去除秘密并执行内容权限。

## 取消、未知和恢复

- 取消请求、连接 ACK、过期租约均不等于实际 OS 停止。
- 租约丢失后保留 unknown 和预算预留。没有重排、租约抢占、第二次 attempt 或静默转云的 API。
- 成功事实与取消竞争时，确实成功仍显示成功；如果发生部分副作用，停止结果必须是 partial。
- 即便旧 Run 已终结，仍能记录原 operation 的迟到结果；不往旧 `allrice_run_events` 补事件，也不重新打开 Run。
- 不匹配当前 attempt/fence 的已认证回执存为 stale；非法终态反转存为 conflict，二者不推进当前投影。
- 续租、真正开始、派发都检查截止时间与 root 取消；操作的真实进程树硬停止、CPU/内存/文件/网络限制属于 P05 及执行端适配，不能用此协议测试代签。
- 维护调用方须定期调用 `expireLeases`，设备重连也需核对权威状态。此 PR 不替换旧 Worker 队列维护器；P03-b/P05 接入时需要安排调度调用，不是表一存在就自动运行。

## 用量与预算

每个操作对根配置的全部维度建立预留，根行锁让并发创建无法越过剩余额度。未来不同类型操作某维度可预留 0，但有效预算上界必须由受信 Broker 与运行适配器推导，不能让模型自行填 0 绕过策略。

正式结算要求 matching task / attempt / accounting ID / source / unit / currency，且是 operation 范围、self-only、measured、cumulative、settled。拒绝父级汇总、估算、未知数、部分窗口 delta 或另一来源。当前实现只接收一次完整计量结算，不消费任意中途累计样本；未来流式用量需增加明确窗口与权威汇聚适配。

`spent` 表示已确认结算之和，不是“已知完整总花费”。`unresolvedReservations` 和 `usageComplete` 显式指出还有未核实用量；不得在界面隐藏这两个字段而把 0 显示为实际零消费。结果终态但计量未知时也不释放预留。实测超出预留会如实入账并触发根 `budget_exhausted` 取消请求，不能丢掉账单假装没超支；是否真的停下仍等待执行端证据。

## 自测与交付证据

真实集成测试启动时必须提供专用 `ALLRICE_TEST_DATABASE_URL`，没有生产 `DATABASE_URL` 回退。使用随机 `p03a_<uuid>` schema，按仓库顺序应用全部迁移，包括 pgvector；结束仅删除该随机 schema。测试实际使用 PostgreSQL 行锁/事务/唯一约束，不是 mock SQL 或 schema 验证替代。

覆盖并发预算预留、重复创建、精确审批消费与事务回滚、一次开始准入、当前撤销检查、结果重复与冲突、断开并重建独立连接、事件重放、过期租约 unknown、迟到证据、取消与结果竞争、截止时间、真实超支、父子根预算、租户/Project/target/Run 隔离及 HTTP 适配所需 Bridge 领取。

```sh
ALLRICE_RUN_DB_INTEGRATION=1 ALLRICE_TEST_DATABASE_URL=<专用测试数据库> pnpm exec vitest run packages/database/src/runtime-ledger
pnpm --filter @allrice/database typecheck
pnpm lint
pnpm test
```

CI 的 `developer-bootstrap` 在专用开发数据库中额外执行本集成文件；普通 `pnpm test` 跳过数据库测试不视为这些场景已通过。本地证据是实际 PostgreSQL 17、完整迁移后的隔离 schema；未凭此宣称真实 Bridge 进程停止、审批网页或云沙箱已验收。

回滚：禁用/移除新入口及模块使用即可，旧调用没有改动；保留新表证据，不在部署回滚时删表或删除待核实操作。没有开启新能力的 Feature Flag，也没有生产数据回填。本轮 merge/Dev 的实际批准和进度由 [执行总表](https://linear.app/metasnowsky/document/allrice-20-执行总表阶段依赖pr-与验收门禁-df09b0b1e681) 的 B1 节奏负责。
