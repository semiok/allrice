# 每人 VM 空闲与准入合同 v1（MET-266）

本合同补充 `person-vm.md`，公开入口为 `@allrice/person-vm` 的 `admission-contract.ts` 导出。它固定 gateway/entry 的 host-only 协议，**没有接线或改变当前 stop/delete/reconcileIdle 行为**。连续 producer、共享权威及消费者均为 **proposed**；类型可引用不代表门禁或产品已经通过。

依据：用户 2026-11-21 决定不等 DSH 上游，按冻结边界合同 v1.0 §9 的门卫/租约实现；持续 20min 同时无原生活动、gateway 本人 inflight/queued、入口本人 active connection/typing/prewarm 后，先冻结双端，再重核，最后安全停机。20min 使用现有 `PERSON_VM_IDLE_MS`；不增加业务阈值、TTL、PG 状态、私有原生接口或事件总线。

## 所有权与依赖

| 项目 | 现状 / owner | 语义 |
| --- | --- | --- |
| `PersonVmBinding`、`PersonVmActivity`、runtime readiness、host hold | 已有 / MET-266 与原生 runtime owner | 不改现有字段与 normal turn/pending approval/hold 保护 |
| `PersonVmAdmissionLease`、`PersonVmAdmissionPort` | 新公开合同，产品 producer/consumer proposed | gateway 与 entry 用同协议；模型 host 是唯一 lease owner |
| `PersonVmAdmissionAuthorityPort` | proposed / 模型 host | 共享权威、phase-independent 校验、比较并执行、wake；不是各 host 独立 map |
| `PersonVmNativeActivityPort` | proposed / 原生 runtime owner → MET-266 | 现有 activity + 当前 schedule deliveries 的完整公开单向投影及连续覆盖 |
| gateway participant | proposed / Workflow 在 #903 之上 | memory wait、8-slot wait、model/refresh transport 与实际 drain |
| entry participant | proposed / 独立线在 #899 之上 | 本人受管连接、typing、prewarm 与准入等待 |

两线只使用公开合同和 host 注入的权威，不读取 VM 私表。合同仅 type-import `contract.ts` 与 RequestContext；VM 不反向 import gateway/entry。不新建 Agent 状态，不改原始 usage、refresh 账本或 DSH 调度语义。

## 格式与可信来源

- `PersonVmAdmissionLease.binding` 必须逐字段匹配 **personId + organizationId + vmId + instanceId + leaseEpoch**。`freezeId` 标识同一次冻结，`version` 是共享权威签发、不可复用的 opaque CAS 修订；只比较相等，不排序，也不能拿 epoch 替代。租约仅由当前可信 host owner 签发；对象形状、guest header、JSON、PID/TTL 均不授予资格。
- `PersonVmActivityCursor.sourceId/revision` 都非空；revision 覆盖相关短活动的 start/end，即使两次 observe 都是 0 也变化。换 owner/重连有缺口、枚举不全或不能证明连续性时，sourceId 换代并报告 unknown，重新积累窗口；不拼接旧窗口。
- `PersonVmIdleCoverage` 的 continuous 是 producer 对 `[from, through]` 每个相关转换的完整公开事实承诺。`idleSince` 是最近一次无已准入活动的起点，active 时为 null；应满足 `from <= idleSince <= through`。UTC 字符串供对账，实际持续时间用可信 host 单调时钟证明；跨来源时域不能比较、时钟跳变或 source gap 时 unknown。freshness 沿既有平台配置，无新增常数。
- known observation 的 `active/queued/deferred` 是非负整数；未知分支不提供这些计数，禁止默认补 0。coverage 可为 unknown，即使瞬时计数已知也不得称连续空闲。`observedAt` 和 coverage.through 必须反映当前真实可核来源，不能由请求端自报。
- 原生投影保留现有 activity 的完整 binding/observedAt/state/四类计数。`activeScheduleDeliveries` 只计当前定时投递、执行和实际收尾，**不等于未来 enabled/armed 计划**；来源缺失为 null + unknown。现有 `workspace/session-activity` 的 schedule 家族包含所有 armed reminders，不能直接映射此字段。精确公开 delivery 映射仍待 owner 核验。

## 活动、排队与连续窗口

gateway 的 active 包含已准入 model fetch、refresh transaction/transport 及其真正收尾；queued 包含已进入 host 的 memory admission、每人 8 路、容量等等待。refresh 不计 charge 不能证明没有 activity；账本 terminal 也不能替代实际 transport/持久化 transaction 已 settled。入口 active 包含已准入连接、typing、prewarm；不得用“无 turn”推断没有这些 host 活动。

freeze 在线性化点之前已准入的 queued 保持 queued，不能改记 deferred。冻结后新到达者只进 deferred，尚未创建 native work/transport；它们保留请求身份、取消和等待责任，但不当作已准入活动重置 idleSince。新连接在门卫外等待时也属于 deferred，不能误记已准入 active connection 导致自锁。source revision 仍记录 deferred 变化，供重新读取与 wake 发现，不丢请求。

freeze 不取消既有工作，也不等 active/queued 清零。重核见到既有 active/queued 即放弃这次停机、精确 thaw，使既有等待继续；不得冻结后等一个被自己阻住的 queued 永远归零。实际归零只发生在真实完成，或取消并 join 全部原生/transport/持久化操作以后，再从完整来源重读；失败或未知仍不是 0。

native producer 必须覆盖本人的所有 root/后代、job、当前 schedule delivery、normal turn/approval 与公开 pending/waking 输入；不完整时 unknown。host hold 继续独立保护，并从最后释放点重新积累空闲，不能拿释放前旧 20min 立即停机。20min 候选取各完整来源与 hold 无保护窗口的交集，即所有 idleSince 的最晚者，并要求所有覆盖确实包含该区间。两个相隔 20min 的零快照不满足。

## 方法、错误、幂等与关闭

| 方法 | 保证与失败语义 |
| --- | --- |
| `observe(binding, signal)` | 可信完整绑定上的快照。读取失败可返回 unknown + reason，或抛现有 `PersonVmError('ACTIVITY_UNKNOWN')`；权限/绑定错误照实抛，不伪装为零 |
| `subscribe(binding, signal)` / `wait(after, signal)` | 先订阅再读取；订阅必须 latch 读与等之间的变化。source/cursor 变化和断线使等待可见；null 使用建立订阅时的水位。不另造总线或轮询常数 |
| subscription `close()` | 幂等；取消并 join 本订阅的 waits。不得隐式 thaw、cancel 工作、关闭整个 participant，或声称远端已收尾；不能把 Promise 仍在跑的等待留在后台 |
| `freeze(lease, signal)` | 在共享权威的准入边界 CAS；返回可对账的 frozen exact lease。相同 lease 重试幂等。返回不保证活动已为零；部分 ACK/取消/失败可能已生效，必须 observe/retry 对账 |
| `assertFrozen(lease, signal)` | 验证完整 authoritative lease 与本端 frozen ACK；不代替原生/host hold 读取，不代替最终原子提交 |
| `thaw(lease, signal)` | 仅 exact binding/freezeId/version 持有者；重复已释放返回 already-released，旧 lease 返回 superseded 且无开门效果。单端释放只登记需求；host 必须收到同次 exact freeze 双端释放 ACK/权威对账后才可实际唤醒/开机/推进 instance/epoch/dispatch。迟到或丢 ACK 按旧 exact lease 对账，superseded 不是释放证据，无跨 epoch 清理例外 |
| authority `assertLease` | 当前 host owner、完整 binding 与 version 的独立阶段校验；starting 可调用，不调用仅 running 的 `assertCurrentBinding` |
| authority `withLease` | 共享比较并执行的 fence，不是 assert 后自由运行。用于 participant CAS 与最终 recheck/物理 stop/确认；同人不嵌套。final callback 内调用只读 assertFrozen，freeze/thaw 在 callback 外，避免互相重入 |
| authority `wake(context, previousBinding, signal)` | deferred 的 participant 调模型 host；提前调用只登记需求，必须先过同次 exact freeze 双端释放屏障，再从当前可信身份/成员资格核本人企业、序列化开机并取得当前 full binding，authenticated/editorReady/canSend 全真才返回。先收齐旧 freeze 的释放，再新 generation；不能把旧 execution envelope 改标签成新 epoch |

沿用 `PersonVmError`：身份/企业不合法为 AUTHORIZATION_DENIED/ORGANIZATION_CONFLICT；精确租约不符为 LEASE_LOST，其他 holder 为 LEASE_CONFLICT；活动/覆盖不明为 ACTIVITY_UNKNOWN；实际活动为 VM_ACTIVE；wake 未达真 ready 为 RUNTIME_NOT_READY；停止/清理未知为 CLEANUP_INCOMPLETE。取消传播原 signal 原因，不能转成成功或零；未知故障保留原因，必要时沿既有 PROVIDER_FAILED。**正常冻结只排队，不向新请求返回 ADMISSION_CLOSED/503 来代替等待**；真实授权撤销、客户端取消、已有关闭错误仍沿现有语义。

## 模型 host 的编排与共享 fence

1. 先 subscribe，再 observe native/gateway/entry，结合 host hold 核持续 20min 候选。任一 unknown/非零/覆盖不完整就保留运行并记录具体来源原因。
2. 从单一逻辑权威取得当前 full binding、freezeId/version；依次/并行请求两端 freeze。两端 ack 或 exact observe 未收齐不得 stop；部分生效先对账，再仅释放自己的 exact lease。
3. 双端冻结后重读全部事实与 hold。freeze 前 queued/active 非零就取消本次停机并 thaw；freeze 后 deferred 留给后续唤醒，不构造已准入活动。
4. 在 authority.withLease 的同一比较并执行 fence 内，再查 exact version/binding、双端 assertFrozen、连续来源当前尾部、native 与 hold，然后物理 stop 并确认。version/来源变化不能沿用旧结论；version 变化放弃 stop 仍只 release 自身 exact lease。普通 assert 后做 stop 存在 TOCTOU，不满足本合同。
5. 停止确认才 exact thaw；单端释放成功及其 deferred wake 请求只能登记需求。模型 host 在同次 exact binding/freezeId/version 的双端释放 ACK/权威对账均完成前，不得推进 instanceId/leaseEpoch、实际开机或 dispatch；先收齐旧 freeze 全部 release，再新 generation。迟到/丢 ACK 先按旧 exact lease 对账，不能用 superseded 当已释放，不设跨 epoch 清理例外。过屏障后先真 ready、重新解析当前完整执行绑定/现权，再 dispatch。guest 原连接随停机关闭的，按原连接取消/join；不擅自跨 epoch 重放旧 native call，不改变去重/usage。
6. stop 结果 unknown 或执行仍未 settled，保留 gate 禁新 dispatch；由模型 host 恢复 owner 对账 native/参与者后决定确认 stopped → thaw/wake，或确认运行且放弃停止 → exact thaw，同样服从双端释放屏障。participant 只报告需求和事实，不自行假定 stopped/开门。

`withLease` 的共享线性化、所有相关 host admission 对它的服从、以及 native 自主 start 的公开边界都必须有实现证据。原生自主 start 若可能绕过 freeze 并在最后读取后发生，producer/owner 必须用公开接缝闭合该 race；不能证明则 unknown、不 stop。声明一个 token、每个进程各存一张 map、订阅最终一致事件或“两次读未变”均不提供这个保证。

owner 崩溃或 ACK 丢失不会自动开门。模型 host 可信恢复先 fence 旧 owner 的实际操作及其子操作，随后共享 CAS 接管/建立新 version，重核 gate 与 native 状态；TTL、连接消失、PID 不存在、心跳超时不能替代该证明。旧 freeze 的迟到 thaw/close 不能影响新 version。整个 fence 至 callback 和子操作真实 settled 才释放；signal abort 只发取消，不代替 join。跨 host 权威/恢复 producer 当前仍 proposed，若必须新增 PG 状态须先报设计核对。

## 原生对照与后续验收

DSH `0.2.1-rc.2` 的公开 Agent.whenIdle/runMaintenance 只有单 Agent 范围；原生 turn/subagent/session-activity 仍按原语义复用，schedule 归档 active 不能当当前 delivery。AllRice 只增加多租户 host 门卫/租约与原生单向事实投影。完整写前核对、源码位置、后续三线估算与直接旧断言见 QA `IDLE-ADMISSION-DESIGN.md`；MET-225 待主会话登记本候选差异。

后续真实入口验证必须包含短活动、未知/断线与重新积累窗口，freeze 前排队/后 deferred、memory/8slot/refresh/drain、部分 freeze/ACK 丢失、版本竞争/迟到 thaw、starting、取消/close/join、跨 host owner 崩溃与恢复、stop unknown、stop 后 wake 真 ready，以及现有 normal turn/pending approval/host hold 保护。加入“一端 thaw 成功即请求 wake，另一端释放延迟/丢 ACK”：只登记需求，旧 exact freeze 双端释放完成前 instance/epoch、开机与 dispatch 均不推进。当前合同无运行证据，不算 ready/已验收。
