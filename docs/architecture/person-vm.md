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

普通路由的 MET-268/MET-271 调用 host-only `resolve(RequestContext, signal)` 与 `assertCurrentBinding(RequestContext, binding, signal)`。两者重新核本人/企业现权、运行阶段、精确 instance/epoch 与出口活性；不返回 ownerToken、不暴露内部表。RequestContext 必须来自各自可信会话/受管连接，不能由 guest header 或 JSON 反序列化生成。resolve 是本次快照，各次实际请求仍须 assert；启动/停止/接管中的租约不发新路由。

正式共享 admission 路径另消费根出口 `PersonVmAdmissionBindingPort.assertAdmissionBinding(context, binding, signal)`，由同一个 `PersonVmService` 提供；未创建 shared host 即拒绝，不接另一 factory/DB 的权威。此口只核当前 user/企业、完整五字段、shared revoked 与内部 exact egress receipt，不公开 receipt/capability/ownerToken，不判断 ready 或授 dispatch 权。正常 freeze/physical lease 不构成资格错误；后续实际工作仍必须在同一 shared boundary 的 admit/queued/activate/finish 内，starting/stop/epoch/recovery 保证不变。egress.assertActive 只核本地 exact receipt，不能反调 VM 校验形成递归。

可信宿主调度另用`PersonVmHostPort`：`reconcileIdle`、`recoverExpired`、`acquireHold`/`releaseHold`。hold参数只有明确kind/operationId及已解析binding，返回host-only holdId；每次现权与epoch复核，不暴露guest工具。原生活动探针在同一可信调用链重入binding校验时，用AsyncLocalStorage中该请求的租约guard，不误判为外部worker；其他请求仍拒绝开停期间的新路由。出口provider的assertActive只核自己拥有的binding回执，不反向递归调用VM的assertCurrentBinding。

## 五面与实施边界

后端 present；MCP none（模型不获 VM 管理权）；员工 UI none（本卡只提供页面/输入预开机服务接口，后续由已批界面接线）；后台 none（没有新增管理界面授权）；权限 present（每调用重查当前可信身份，删盘单独授权/审计，不默认删盘）。默认关闭/名单由发布入口控制，本包不新增产品开关。

**20 分钟自动回收、运行中的普通安全 stop/delete/takeover 尚未实现。** 锁定 DSH 0.2.1-rc.2 的公开 `Agent.whenIdle/runMaintenance` 只覆盖单 agent；workspace 活动是瞬时快照，归档 stop 只发停止请求、不等收敛；未找到覆盖本人 VM 全域的连续活动水位与原子新任务准入冻结。采样之间可发生短 job，最后一次0之后也可产生工作，缩短轮询间隔不能补证明。当前 `reconcileIdle` 对 running 永远保留；普通停机/删除/接管在 running 瞬时0时仍拒绝 `ACTIVITY_UNKNOWN`，active/unknown/stale/host hold 继续拒绝。不会新增虚构 native gate 或第二套 Agent 状态机，不能把 fixture 通过当原生能力已接。

仅 native 已真实 stopped/absent 时，可对账后清理并从确认的 stoppedAt 计算7天转冷。刚确认停止不能因旧 lastActivityAt 立即冷。自己本次启动失败的清理仍撤出口、尝试物理stop、确认后detach。权限撤销强制终止是另片已批需求，不作为普通 idle 回收证明。长周期测试只用时间夹具，未实等20min/7day；不做 Full 快照、不自动删盘。

冷盘为未挂载加密镜像在同一存储根 warm/cold 目录的移动。host-only `disk.inspect(vmId)` 非破坏性检查两个位置：完成凭据记录创建成功后的 vmId 与外层镜像 dev/inode，原 key 通过公开 imageinfo 识别容器；仅一个精确匹配镜像才可回写实际 diskTier。rename 成功但DB回写失败后，可以重复 move 或在恢复 mount 前对账；原字节不复制或重建。两个位置同时存在、凭据/容器/key不明都保留并拒绝。这不宣称完整文件系统健康检查；不能恢复的损坏仍需专门恢复。

首次建盘失败且确证两个位置与完成凭据都不存在时，create允许同vmId用原key幂等重试；完成且匹配的镜像只认领，不覆写；部分盘或不完整凭据保留并拒绝。完成凭据0600存于独占host存储根的manifests目录，须与镜像/密钥共同纳入后续备份恢复集合；不是guest可改的授权来源。

ownedData为迁移0247的`person_virtual_machines`与`person_vm_audit`、私有配置根下的warm/cold加密镜像和分离key store；没有员工外键级联。两表同PR登记收敛基线，归属租约/账本。默认FilePersonVmKeyStore只证明本机分离存放和0600权限，不等于生产离机密钥托管；生产密钥服务与共同备份/恢复集合仍需后续接线并验收。

首次创建空 MSB_HOME 先用公开 `msb pull <固定digest> --materialize flat --quiet` 预置，再 create `--pull never`。镜像来源是可信 host 固定配置，guest 不参与选择；host 工件下载控制与 guest 出口验证分开。

M1 的 `socketRoot` 必须由可信 host 提供独占短目录，保持显式 `/tmp` 拼写，不把 socket 别名 realpath 成更长的 `/private/tmp`。v0.7.16 没有单独的 `run`/socket 路径配置，`run_dir=home/run`；canonical control 路径为 `home/run/sandboxes/<24hex>/control.sock`，其中24hex来自原生SHA256(name)前12字节。构造时按完整UUID固定36字节作纯资格预算，长socketRoot在服务装配进入egress/move/attach前即拒绝，并快照已校验配置；prepare仍按实际binding在本方法目录/配置/命令副作用前检查同一衍生路径的UTF8字节数与Darwin `sun_path[104]`（严格小于104），不再用无原生依据的home≤70；不生成短person/VM ID或新映射。完整UUID的home最多51字节，因此socketRoot最多14字节；例如host `mkdtemp('/tmp/a-')` 得到13字节独占0700目录，home50/control102。长数据/加密盘路径仍只作为软链target，完整vmId别名的不同target冲突仍拒绝，不覆盖已有别名。此预算绑定固定原生版及Darwin ABI，升级须核[run_dir](https://github.com/superradcompany/microsandbox/blob/0fefb8f2fed3da964819afd222227dc1c5b0e78f/sdk/rust/lib/config/mod.rs#L574)、[canonical端点及pair校验](https://github.com/superradcompany/microsandbox/blob/0fefb8f2fed3da964819afd222227dc1c5b0e78f/crates/runtime/lib/client/ipc.rs#L175)。

每次开停/hold持有PG advisory锁与持久owner租约。`recoverExpired` 只在过期且旧操作已可靠fence时运行：先撤旧出口→确认旧native停止→卸载→CAS清owner。默认实现能证明同进程原callback及子进程promise已settled后的数据库断线恢复；普通业务/原生错误不会因类型未知永久留owner。跨进程/跨host没有可靠fence时拒绝，`PersonVmLeaseFencePort` 留给MET-274接线；TTL或PID存在性不证明旧操作不能再执行。活动hold不会靠TTL自动变成0，异常hold的可信对账同属后续恢复边界。

恢复在调用物理provider前先CAS登记新的唯一recovery owner、消费前代settled证明，guard/save/清owner只认新token。即使恢复自身PG连接被终止、advisory锁已释放，也不能拿前代证明再做物理清理；本地active recovery拒绝重入，其他host须fence新owner。只有恢复callback及其失败清理/命令真正settled、client销毁后才登记新owner的本地证明。claim提交回执未知时，可分别保留尚未消费的前代证明与新token收敛证明，但任何新物理工作都须核当前持久owner；onclose或TTL不是收敛证明。

无instance的恢复同样先inspect盘：ready回写真实warm/cold位置；首次建盘阶段absent恢复为failed可重试而非stopped，unknown/部分盘保留拒绝。挂载与host盘对账分开，显式授权删除也按vmId查实际位置，确认warm/cold镜像都已移除后才删完成凭据/key并记成功。

PostgresPersonVmStore构造参数为`PersonVmSqlFactory`：每次调用返回全新、未使用、独占的`postgres(url, { max: 1, ...可信数据库配置 })` client，由store在每次read/withLease/recover结束时调用公开`end({timeout:0})`销毁。不能传Web pool、缓存同一client或让工厂返回已经使用的client；复用client或max非1会拒绝。max:1与操作独占保证advisory锁的全部SQL都在同一session上，不依赖reserve/release重新入池。resolve/assert每次也会建连接，网关逐chunk调用将产生相应连接/鉴权开销，目前未实测吞吐；后续容量治理需实测优化，不可用不可信缓存或旧epoch资格替代当前现权检查。factory不得在其他模块改为共享client。

postgres.js 3.4.9的`release()`无条件把reserved连接标回可用，FATAL关闭后的query/errorResponse直到ReadyForQuery才清理。因此这里只用公开onclose和SQL错误作废当前client：每条SQL同时等待关闭事件；连接错误发生即拒绝该操作后续guard/save/audit，避免失败审计抢在关闭通知前再次发送SQL。无论成功失败均销毁该client，下一次读取/恢复来自全新session；普通SQL/业务错误仍清owner。断线保留durable owner，同进程settled证明仍要等原callback及物理清理结束，不用重连、TTL或SQL报错代替fence。源码依据：[reserve/release/onclose/end](https://github.com/porsager/postgres/blob/v3.4.9/src/index.js)、[ErrorResponse/closed/ReadyForQuery](https://github.com/porsager/postgres/blob/v3.4.9/src/connection.js)。

接管/失败重开也先核真实native状态与当前原生活动/host hold；可靠fence不等于原生任务已结束，当前running缺少原子停机保证即拒绝。recoverExpired与普通租约使用同等短生命周期的AsyncLocalStorage frame/guard，当前可信探针可重入，其他requestId即便本人相同也看不到该frame资格，回调settled后frame立即失效。新启动本次自身的失败清理仍尝试撤销、物理停机并确认；后续跨进程恢复由MET-274接线。revoke的实现由MET-269负责取消/join该binding在途流并记效果未知，VM层不能仅凭调用前的一次binding检查宣称长期流已回收。

源码依据：[v0.7.16 start](https://github.com/microsandbox/microsandbox/blob/v0.7.16/crates/cli/lib/commands/start.rs)、[create](https://github.com/microsandbox/microsandbox/blob/v0.7.16/crates/cli/lib/commands/create.rs)、[pull](https://github.com/microsandbox/microsandbox/blob/v0.7.16/crates/cli/lib/commands/pull.rs)、[list JSON](https://github.com/microsandbox/microsandbox/blob/v0.7.16/crates/cli/lib/commands/list.rs)。hdiutil的stdinpass按系统man使用NUL结束，不把key放命令参数或环境。

真实前置：固定 v0.7.16 二进制与其公共配置、宿主加密盘密钥托管、MET-269 出口、DSH 装配与活动/就绪公开接缝、MET-271 身份/BFF 页面绑定。未绑定这些前置时不得报可交付或迁入完成。样机证据只作实现参照，不替代产品验收。

故障依据为domain错误、开停/删盘audit、持久phase/租约和真实native/hdiutil检查；`CLEANUP_INCOMPLETE`或未知物理状态不能冒称已释放。自动巡检/告警尚未接入，交主会话在MET-222登记VM失败/残租约/残挂载监测项。运行时装配仍需证明员工/工作区绑定后的实际编辑器可发送，本卡没有用协议fixture替代该证据。

## n2-A starting owner / native bootstrap kernel

`PersonVmRuntimePort.memoryGuestPlan(binding, signal)` 必须注入 MET267 公开 `VmMemoryGuestPlan`（当前候选 `fbbc52163f82e2e201e2d6bfe835e709f3f2abc2`）的实际工件，不能从 guest 请求选策略。`PersonVmMemoryGuestPlan` 只作结构投影，没有复制内存策略。缺该函数或 native bootstrap，在出口/挂盘/原生 create 前拒绝。`MicrosandboxPersonVm.bootstrap` 实际用公开 managed exec 创建父目录、私有临时 stage + `cp` 保留 mode、detached node initializer + exact `wait --job --format json`；initializer exit0 且非 timed-out 后才进入 runtime.start。临时 stage 位于本次加密挂载内的0700 host-home，用完清除，不暴露其路径。原生 CLI/source 固定 v0.7.16 `0fefb8f2fed3da964819afd222227dc1c5b0e78f`，cp 会 resolve/start，必须只在真实 starting owner 内调用。

`start(binding, signal, scope)` 的第三参 `PersonVmBootstrapScope` 为 host callback 能力：仅含 frozen binding、startup signal、`assertCurrent()`、`launch(command)`。assertCurrent 直接核本次 active lease frame、真实 PG guard/现权、starting/full instance+epoch、admission 及精确 egress receipt，不调用只支持 running 的 resolve、不泄露 ownerToken/key/host盘。callback settle 后 scope 立即禁止新操作，abort 并 join 已发起的 scope 调用，持物理租约到实际收尾；回调返回不能把未 await 的原生 launch 留给释放器。启动 callback 必须等实际 startup/control 操作 join，并将长生 native job 交给真实 runtime owner；startup signal 返回即失效，不能用作 DSH 的长期信号。ready 前后仍重核同一 starting owner。

`scope.launch({executable,args,env?,workdir?})` 只能在 person init 成功后调用，执行固定 `plan.launcher <native executable> ...argv`，env 合并固定 plan.env，冲突拒绝。返回 `PersonVmManagedJob{binding,jobId,wait(signal),cancelAndWait(signal)}`；wait 返回 `{exitCode,timedOut}`。handle 精确绑定 sandbox/job，可由 native owner 持有以完成读取/取消，不能启动新命令；其 cleanup 不依赖已撤销本人的普通权限。公开 native wait 先输出 JobExit JSON 再以 guest code 退出，所以仅该内部调用允许读取正常非零 CLI 退出的 stdout，严格核 code/success/timed_out；spawn、abort、signal、超限或无合法 JSON 都不算 join。cancelAndWait 即 exact kill + wait，kill 失败仍试 wait，CLI 被杀或 wait 超时本身不证明 guest 完成。host 应给 start/prewarm 传入覆盖启动预算的 AbortSignal；原生 wait 的超时不杀 job，本适配以该信号取消等待再执行 kill+wait，不声称已设置原生 job deadline。`jobCleanupTimeoutMs` 为 host 可信配置（默认10000ms），独立于已取消 startup signal；未知 job ID/通信/完成状态走现有 revoke→native stop/status，仅确认停止才 detach，不能扫描猜 id、重放 initializer 或报告 ready。

同一 running start 入口只重核 readiness，**不重跑 person init**。MET273 运行中新员工须由真实 running owner 继续用已安装 launcher/env，不可复用过期 starting scope 或重配活跃 cgroup。本 kernel 不建立 DSH 控制通道/guest header 身份；273 必须实际装配 native owner、认证 editor/send ready、独立员工 homes/配置/会话与所有 launcher。未装配时不得返回 ready。此片不证明 MET26702 镜像内没有抢跑 producer、04 exact-child/OOM、实际2G运行读回、n2-B全 producer/20min 或组织撤权；真实联验另排，协议 fixture 不作产品启动验收。

### Native Web local auth（MET273 首片）

首次员工端口以 `preparePersonNativeWebRoster` 的 DB 现权结果为源，跨当前企业本人全部可访问 workspace，仅读真实 active assignment/本人实例并稳定物化 general 实例；不创建分配、Run 或模板实例。`PersonVmService.nativeWeb` 在原 PG owner frame 中调用 provider；未配置的旧启动路径不变。

`prepareWebEndpoints` 将实际实例及版本/端口写入加密 MSB_HOME 内固定0600 host-only manifest。它是派生文件，不能授权身份，须与 DB digest 及公开 `inspect` 的 desired/active `network.ports` 精确对账（`pending_changes` 不覆盖端口）。仅 native absent 才取得 OS 分配端口，真实 `create -p 127.0.0.1:H:G`；端口竞争失败不重分配或杀占用方。

现有 native 映射缺失/清单变化返回 `WEB_ENDPOINTS_PREPARING` 并结束本次准备，不持活动 hold 等 idle，不 hot-add/modify/restart 已运行 VM。后续三方 freeze、完整 native producer 静默和新映射安全 stop/start 不在本片。

host-only `PersonVmWebStartup` 随 bootstrap 回调传递完整 binding/epoch、真实 roster receipt 和可信 context，不序列化到浏览器。Worker `createAssignedNativeWebStartup` 将每实例原生 patch 合入一次 person memory init/staging，再逐个交真实 `openNativeWebOwner`，独立员工 HOME/agentsHome、共享 `/work`；长期 job 不依赖过期 startup signal。

该组件只提供实际 startup/control owner，不提供 editor/send readiness 或 native ancestry catalog。271 的 HTTP/WS/catalog、真实 ingress 配置和发布开关、269/267生产 factory、editor-ready 仍须正式装配；当前 listener 未接新流量，不把 controlReady 转成 canSend。默认关闭和真人禁用保持，shared browser/MCP/instructions 属后续员工装配。

可选 `BootstrapScope.readNativeWebAuth` 仅在 starting callback 内调用，和 launch 一样先后核真实租约、取消并 join；真实 Web owner 缺此能力即拒绝。输入为可信 host 的规范 DSH_HOME、nonce、原已发布 loopback origin 与预算；只读该 nonce 的有界普通文件，返回私有 native authenticatedUrl，不进入 view/argv/日志。Worker 原生 Web owner 保留 exact Job 与独立 lifetime；control baseline 只证明控制链可达，失联即 unknown，不能替代 editor/send、业务准入、全域idle或 guest完成。后续271代理和组织现权失效必须接该独立 lifetime，当前没有生产流量装配。
