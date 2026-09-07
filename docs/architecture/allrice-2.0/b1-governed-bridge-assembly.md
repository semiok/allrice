# B1：Bridge 操作账本与真实权限装配

`createGovernedBridgeOperationLedger(device, options)` 把 P03-a 事务账本、P03-b 设备 HTTP 协议和 P04 确定性政策接在一起。生产 HTTP 路由没有 Allow stub；开关 `ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED=1` 仍默认关闭，开关本身不安装任何租户 Allow 规则。

## 可信入口与状态来源

- 建立操作时，`initialOperation` 是受信服务器 Tool Broker 规范化的绑定和解析后 payload。它不是浏览器提交的“我已授权”。工厂解析并复制输入，不保存调用方可变对象引用。
- 已存在操作从 PostgreSQL 的不可变 `initial_snapshot` / `bridge_payload` 重新读取。即使提供同 ID 的 initialOperation，也不能覆盖已持久输入。
- 准入/审批解析器使用当前事务普通 SELECT 读取不可变操作输入；不可嵌套调用另开事务的账本读接口，也不可追加 controls→operation 的反向锁。根→operation→政策/当前资源→审批的锁顺序不变。
- `policyOptions` 供已认证服务端审批服务复用。`createRoot`、预算来源、读接口和根取消仍要求上游可信身份与作用域，工厂不是公开设定预算 API。

## 实际检查

每次建立、派发、开始与续租均由 P04 检查当前成员资格、冻结政策、Run 状态、租户规则和精确审批。适配器另外解析：

- 真实设备的 owner/租户/工作区、未撤销、实际能力和 90 秒心跳；时间检查在资源锁等待后进行。
- 真实目标必须是 `bridge.<deviceId>`，metadata 的 `bridgeDeviceId` 同设备，目标在线且含对应文件能力。
- 当前目录 grant 的所有者、设备、root fingerprint 和递增 generation。B1 仅支持 `in_place`，workCopy.id 等于真实 grantId，不发明“已创建工作副本”的记录。
- Run execution_spec 的规范化摘要；employeeVersionId 同真实 employee_run 关联。会话存在时核对当前 Session 所有者、版本、未归档和运行中的 Run/generation。非聊天 Run 使用 null Session 和 generation=0。B1 projectId 只能是 null。
- 精确解析 payload 的 action/inputDigest。没有 Shell、跨目标数据出端、任意 baseline 或 command 绑定适配器；未来能力不能靠配置 Allow 自动注册。
- 路径只能是安全相对语法；只允许目录列表/搜索等使用根目录 `.`。写入要求显式 expectedSha256（null 为新建意图，摘要为更新预期）。这些是准入条件，不冒充 OS 沙箱或无竞争 CAS。

P04 决定哪些既有工具可准入，工厂不另建一套能力白名单。用户所有日常任务不会在本批自动切入新账本，旧命令、旧 Bridge 和旧 Worker 维护链路保持兼容。新审批 UI、真正沙箱/新 Runner 和生产常开属于后续批次。

## 待审批队列的有界公平性

一次设备领取至多检查 20 个候选。明确的待审批/撤销/策略拒绝结果映射为 unavailable，跳过该候选；数据库错误、缺失或损坏政策等未知故障继续暴露，不伪装为空队列。

候选按 updated_at、created_at、id 排序。预期拒绝回滚后，只更新仍处于等待/ready 的候选 updated_at，使其轮转到未检查候选之后。updated_at 因此同时表示最后状态变动或派发准入检查时间，不是批准时间。此操作不修改 binding、审批或执行状态；超过 20 条待审批不会永久饿死后续已批准动作。

## 验收

真实 PostgreSQL 测试使用随机隔离 schema 和全部迁移，不借用生产数据库、不 mock 授权。公共 vector/pg_trgm 扩展在数据库级事务锁下安装到 public，避免并行测试删除其他套件依赖。

```sh
ALLRICE_RUN_DB_INTEGRATION=1 ALLRICE_TEST_DATABASE_URL=<专用测试数据库> pnpm exec vitest run packages/database/src/runtime-governed-bridge.integration.test.ts
```

覆盖真实 Ask 持久化、六路并发仅一次派发/审批消费、一次开始、重新构造工厂恢复、待审批队头及 20+ 轮转、设备/目录/心跳/能力/目标/成员/Run/政策撤销、伪造工作副本/Session/employee/generation/payload、缺失政策不能静默忽略、调用方可变输入和写入基线。

回滚只关闭新协议入口并保留账本证据；不删除未知结果，不释放未核实预算，不把未收到停止证据描述成已终止。
