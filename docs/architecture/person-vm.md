# 每人 VM 公开接口 v1（MET-266 / M1-02）

基线 `6bf356b5`，冻结边界合同 v1.0。公开入口为 `@allrice/person-vm`，符号 allowlist 见 `packages/person-vm/src/index.ts`。本模块拥有个人盘、宿主 VM 记录、所有权租约与开停审计，不拥有 DSH turn/job/子任务/审批状态。

每个全局 `personId` 只建一条 VM 记录，当前企业由可信 RequestContext/权限服务校验。第一阶段遇到同本人不同企业的绑定拒绝 `ORGANIZATION_CONFLICT`，不暗建第二台 VM、不跨企业复用会话或权限。跨企业安全切换留待身份入口合同绑定。员工仅配置/线程分离，文件和浏览器在本人 root 域共享；删除员工不会调用 VM 或个人盘删除。

## MET-269 出口接线

`PersonVmBinding` 的 vmId/instanceId/leaseEpoch 由 host 产生，组织/本人取当前可信服务上下文。`ownerToken` 只在存储租约内部，既不进 guest，也不进 PersonVmView。guest 自报的 header/person/epoch 不能建立信任。

1. 持久化新租约和 epoch，先处理旧 epoch 的撤销/真实停机；未确认停止不开始新实例。
2. `egress.prepare(binding, signal)` 返回 `PersonVmEgressReceipt`；内含完整 binding、不可空 bindingId、host gateway ports。VM 服务逐字段比对，缺门卫或不匹配时 fail closed。
3. `egress.assertActive(receipt, signal)` 后才调用原生 create/start。Microsandbox 双向默认 deny，只允许指定 host TCP gateway；guest 不能要求额外公网目的地。实际只读/下载/外发语义由 MET-269 执行。
4. 原生 agent ping 只证明命令通道；DSH runtime 的 authenticated/editorReady/canSend 全真才返回 ready。HTTP 401 不算可发送。
5. stop/failure/takeover/delete 均先 `egress.revoke(receipt, reason, signal)`；撤销失败仍尝试 native stop，并检查确已停止。停止不明不卸载盘；撤销或停机失败不报成功。清理使用独立有界信号，不因用户取消跳过。
6. 新 epoch 不能复用旧外部资格。MET-268/MET-271 在各请求入口实时校验当前本人、企业、epoch 与实例；此包不会把 guest 自报身份传为权威。

prepare/assertActive/revoke 均 host-only，不是可让模型调用的工具。撤销必须幂等到精确 bindingId/epoch，不能把旧实例的延迟撤销作用到新实例。

v0.7.16 的 `start` 不接受网络覆盖参数，因此 MET-269 必须为每个 vmId 保留同一组 gatewayPorts；首次 native create 后把端口固定在存储回执，后续 prepare 若改端口即拒绝。绑定资格与 epoch 每次更新，不能用固定端口当身份。原生 idle-timeout 不启用（detached job 可能不重置原生 idle），20 分钟策略只由 host 依据活动事实执行。

MET-268/MET-271 只调用 host-only `resolve(RequestContext, signal)` 与 `assertCurrentBinding(RequestContext, binding, signal)`。两者重新核本人/企业现权、运行阶段、精确 instance/epoch 与出口活性；不返回 ownerToken、不暴露内部表。RequestContext 必须来自各自可信会话/受管连接，不能由 guest header 或 JSON 反序列化生成。resolve 是本次快照，各次实际请求仍须 assert；启动/停止/接管中的租约不发新路由。

可信宿主调度另用`PersonVmHostPort`：`reconcileIdle`、`recoverExpired`、`acquireHold`/`releaseHold`。hold参数只有明确kind/operationId及已解析binding，返回host-only holdId；每次现权与epoch复核，不暴露guest工具。原生活动探针在同一可信调用链重入binding校验时，用AsyncLocalStorage中该请求的租约guard，不误判为外部worker；其他请求仍拒绝开停期间的新路由。出口provider的assertActive只核自己拥有的binding回执，不反向递归调用VM的assertCurrentBinding。

## 五面与实施边界

后端 present；MCP none（模型不获 VM 管理权）；员工 UI none（本卡只提供页面/输入预开机服务接口，后续由已批界面接线）；后台 none（没有新增管理界面授权）；权限 present（每调用重查当前可信身份，删盘单独授权/审计，不默认删盘）。默认关闭/名单由发布入口控制，本包不新增产品开关。

空闲 20 分钟与 7 天转冷都由宿主租约回收器执行；native 活跃事实不可用/过期、接管、启动或 host hold 活跃时保守保留。host hold 只补宿主在途工作，不是原生状态权威。7 天转冷只卸载/保留加密盘，不做 Full 内存快照，也不自动删盘。长周期测试用时间夹具必须明确未实等。

20 分钟依据 lastActivityAt；7 天依据已经确认物理停止的 stoppedAt，刚完成 idle-stop 不能因老 lastActivityAt 立即转冷。冷盘为未挂载加密镜像在同一存储根 cold 目录的移动；重启先移回 warm，再以原密钥挂载，原生所有可写MSB_HOME留在盘内。

原生活动接口只提供当前事实时，host从首次已知空闲开始连续计时；活跃、unknown、失联或两次观察间隔超过activityMaxAgeMs时重新开始窗口。启动时间不能当空闲起点。`reconcileIdle`的可信调用者必须持续取得新鲜原生事实；缺少观察不会为了回收而推断0。计数/观察仅作为宿主回收门卫，不反向控制DSH任务状态。

ownedData为迁移0247的`person_virtual_machines`与`person_vm_audit`、私有配置根下的warm/cold加密镜像和分离key store；没有员工外键级联。两表同PR登记收敛基线，归属租约/账本。默认FilePersonVmKeyStore只证明本机分离存放和0600权限，不等于生产离机密钥托管；生产密钥服务与共同备份/恢复集合仍需后续接线并验收。

首次创建空 MSB_HOME 先用公开 `msb pull <固定digest> --materialize flat --quiet` 预置，再 create `--pull never`。镜像来源是可信 host 固定配置，guest 不参与选择；host 工件下载控制与 guest 出口验证分开。

每次开停/hold持有PG advisory锁与持久owner租约。`recoverExpired` 只在过期且旧操作已可靠fence时运行：先撤旧出口→确认旧native停止→卸载→CAS清owner。默认实现能证明同进程原callback及子进程promise已settled后的数据库断线恢复；普通业务/原生错误不会因类型未知永久留owner。跨进程/跨host没有可靠fence时拒绝，`PersonVmLeaseFencePort` 留给MET-274接线；TTL或PID存在性不证明旧操作不能再执行。活动hold不会靠TTL自动变成0，异常hold的可信对账同属后续恢复边界。

PostgresPersonVmStore须使用本模块专用pool。通过postgres.js公开onclose通知把失联reservation作废；不对断开的reserved连接再查询或release，也不把普通业务异常当失联。关闭通知会保守作废此专用pool的在途VM租约，不与Web/其他业务共享pool。

接管/失败重开也先核真实native状态与当前原生活动/host hold；running且活跃、未知或探针失联时拒绝回收。可靠fence不等于原生任务已结束。新启动本次自身的失败清理仍尝试撤销、物理停机并确认；后续跨进程恢复由MET-274接线。revoke的实现由MET-269负责取消/join该binding在途流并记效果未知，VM层不能仅凭调用前的一次binding检查宣称长期流已回收。

源码依据：[v0.7.16 start](https://github.com/microsandbox/microsandbox/blob/v0.7.16/crates/cli/lib/commands/start.rs)、[create](https://github.com/microsandbox/microsandbox/blob/v0.7.16/crates/cli/lib/commands/create.rs)、[pull](https://github.com/microsandbox/microsandbox/blob/v0.7.16/crates/cli/lib/commands/pull.rs)、[list JSON](https://github.com/microsandbox/microsandbox/blob/v0.7.16/crates/cli/lib/commands/list.rs)。hdiutil的stdinpass按系统man使用NUL结束，不把key放命令参数或环境。

真实前置：固定 v0.7.16 二进制与其公共配置、宿主加密盘密钥托管、MET-269 出口、DSH 装配与活动/就绪公开接缝、MET-271 身份/BFF 页面绑定。未绑定这些前置时不得报可交付或迁入完成。样机证据只作实现参照，不替代产品验收。

故障依据为domain错误、开停/删盘audit、持久phase/租约和真实native/hdiutil检查；`CLEANUP_INCOMPLETE`或未知物理状态不能冒称已释放。自动巡检/告警尚未接入，交主会话在MET-222登记VM失败/残租约/残挂载监测项。运行时装配仍需证明员工/工作区绑定后的实际编辑器可发送，本卡没有用协议fixture替代该证据。
