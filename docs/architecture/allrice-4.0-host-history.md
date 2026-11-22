# MET-274 宿主历史 v1 装配清单

离当前目标还差什么：273 的冷 source、历史配置 pin/checkpoint/恢复存储根，以及
附件对象 ACL owner 仍未绑定。271 正式持久 root/现权已消费，独有 history GET 已注册；
生产缺 273 时鉴权后关闭订阅并返回 503。测试替身不构成完整生产装配或真实 VM 验收。

## 已有公开接缝与本轮修正

冻结依据为 `BOUNDARY-CONTRACT.md` v1 §4/5/6/7/9。不修改冻结合同或新增 carrier。

| 接缝         | 现有符号与保证                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原生单向投影 | `captureHostHistory` 只消费锁定 rc.2 公开 `SessionController.inspect`、`dsh-session` append-origin/closer；不调用 resolveAgent、prompt、repair 或 retry |
| 固定数据合同 | `@allrice/contracts` 的 `HostHistoryBinding/Attachment/Entry/Snapshot/Page` 及对应 Schema、`HostHistoryStorePort`；无新增权限或执行状态                 |
| 宿主存储     | `@allrice/storage` 的 `HostHistoryStore`、`hostHistoryDigest`、`HostHistoryIntegrityError`；不可变文件、完整前缀、摘要固定分页，损坏/回退/分叉拒绝      |
| BFF          | `createDEntryHistoryRouteHandlers` 消费 271 正式 root/watch，组合既有 history/download 工厂；冷读不进入 live owner、VM、模型或认证刷新                  |
| 附件 owner   | 现有 `DEntryHistoryAttachmentPort/Handle` 的 acquire/reauthorize/revoked/open/close；没有真正通知和 join 的 owner 时下载 503，历史仍可读                |

本轮将 source 的 header/hash/throughSeq 在等待附件导出前固定，保证与同次同步
投影的条目属于同一读取切面。存储读取另核所有相同原生游标的完整快照摘要，避免
先读到较长前缀时漏检旧同游标快照的工具结果/附件冲突。等待 binding/store/inspect
的迟到结果返回后立即检查撤权，阻止继续准入下一步读取。

DSH 原生依据：当前 `0.2.1-rc.2` 的 `SessionController.inspect` 声明明确不激活
Agent；`resolveAgent` 会 resolve/resume。原生日志是权威。AllRice 只补已批准的
门卫、单向展示账本和宿主存储；既有登记 id 为 `allrice-host-native-history-v1`。
本轮无新 DSH 接缝、私有 import、补丁、状态机、PG 表、重试、TTL 或产品默认值。
MET-225 由 root 核对该既有行；本文不声称已在线更新。

## root 可执行的生产装配顺序

1. 收齐各 owner 的具名公开出口、exact SHA/tree/blob、参数/错误、撤权覆盖范围及
   实际 I/O join 说明；无具体 v1 签名的口先由 owner 封版，274 不深导入内部实现。
2. 已消费 271 `3dcde5079ede7c023c466073828ff8c612e3e046` 的数据库 barrel 公口
   `getDEntryHistoryRootPin` / `watchDEntryHistoryAuthority`。可信当前登录取得 RequestContext，
   LISTEN/register 先于现权重核；后续读再次核同 identity/root/origin digest/birth binding。
   无 root/claim-only 返回 404，不创建或重放。271 只提供 root；273 冷子会话祖先未交时
   不信浏览器 parent，也不借 live VM admission/rollout 作为历史门槛。
3. 273 提供与同线程历史 instance/profile/session/root/config release+digest 匹配的
   冷 inspect source，以及受权 checkpoint/停机导出顺序。当前 roster、启动 config、
   controlReady 都不能充当历史 pin。不能为读历史调用 prepare/start/open/resolveAgent
   或刷新凭据。缺口依据见 QA `met273-employee-runtime-20261121/PUBLIC-SOURCE-FOR-MET274.md`。
4. 由 host owner 选择持久 `HostHistoryStore` 根目录。capture 只在已批准 checkpoint
   调用；导出完成、实际 I/O join 后才进入原 owner 的停机边界。历史模块不提供新的
   freeze/fence/restore 状态。物理 owner fence 归 266/273。
5. 对象 owner 绑定无漏通知窗口的 acquire + 当前授权；revoked 覆盖对象 ACL 的独立
   变化，不能复用身份信号代替。pending acquire 失败前自行清理，open/reauthorize
   取消后等待真实操作收敛，close 释放并 join。继续使用不可变 ID/checksum/size/mediaType
   与私有 spool 完整验证；单次 getStoredFile 查询不满足通知合同。
6. 已注册本卡独有 `/api/v1/d-entry/history` 与 `/history/download` GET；生产不注入测试
   feed。只复用既有 binding/store/files 组合口，未提供 273 时明确 503，无默认存储或
   配置猜测。JSON 返回前、流 EOF/cancel/error、部分初始化失败均 await subscription.close；
   下载通过独立 closeAuthority 回调等待它，仍分别等待对象 owner，不混淆两种权限或 join。
   共享通知 feed 的进程生命周期仍归 271。页面接线归 UI owner，历史不提供 execute/continue。
7. 单列恢复 manifest：宿主快照/schema/digest/完整 source cursor、原生
   DSH_HOME/DSH_AGENTS_HOME/JSONL/附件/工作区、历史配置 release/digest、真实对象
   pins 与字节，以及 VM 盘/外部存储边界。业务 operation/approval/receipt 和模型账本
   由各自 owner 公开导出；274 不查其私表。受权恢复到新根后核 manifest，再切换。
8. 真实装配后验证关机/网关离线时分页、工具展开和附件下载，VM 启动、模型请求、
   原生认证刷新计数均不增加。再做真实 kill、断流、commit-before-ack、同盘恢复；
   未结束、interrupted、结果未知分别保留，业务效果先由 receipt owner 对账。
   显式新执行沿已有执行门卫和自己的执行身份，不能重放旧调用或补造历史 Run。
9. n3 默认关闭且无旁路；267 完成前不给真人使用 VM 路径。受影响测试、Astra 和
   批次最终门禁由 root 安排，不把本轮静态检查当作门禁或 Dev 验收。

需要 owner 完成交付以上已有职责；本轮不要求扩全局合同。新的 source/config/
checkpoint/route 具体生产签名如超出 v1，须先由对应 owner 与 root 核定并封版。

## 合同测试及未证明的内容

原 `history.test.ts` 的 48 例（含已完成原版/变异检出的两个 close 屏障组）原字节保留。
新增 `history-authority.test.ts` 为合同 unit，`history-authority.integration.test.ts` 沿
`ALLRICE_RUN_DB_INTEGRATION` / 原 collector，登记单个 db 资源文件；无新 manual 例外。

- 用真实 `HostHistoryStore` 文件及新实例/BFF 验证固定快照重开、分页、工具结果与
  附件 pin 不被后续 capture 升级，及恢复文件集合冲突拒绝。
- 验证 source 切面、崩溃前缀/断流/原生 interrupted 记录重读、宿主 export
  commit-before-ack 后重读；读历史不重新 inspect、自动修复或执行。
- 用受控 pending owner、撤权信号与独立 drain/close 屏障，检查撤权后的迟到返回和
  实际 Promise join，分别覆盖 binding、inspect/export、acquire、reauthorize。
- 无 v1 execute/业务 receipt 具体接口，因此显式新执行及业务 commit-before-ack
  仅为测试局部替身；不宣称真实 VM kill、对象权限通知、业务对账或生产不重复通过。
- 新 PG 套件复用既有隔离 fixture，以真实 cookie、公共 root/watch、默认 PG LISTEN/NOTIFY
  验证历史现权及 pending 读撤销；273 配置/宿主投影和对象 ACL 仍明确为替身。fixture
  建立初始 root 使用原 owner 服务，不复制 claim/pin SQL，不作为生产创建装配。

本轮不运行正式测试。root 必须整文件运行新增及既有 history 测试，再跑直接受影响
的既有 D-entry 套件；命令、完整文件列表与首败保留要求在本轮 QA
`consume-271-20261122/IMPLEMENTATION.md` 和执行包中。静态准备不算测试通过。
