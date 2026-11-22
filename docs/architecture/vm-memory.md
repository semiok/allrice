# MET-267：人级 VM 内存准入与命令保护

本片将历史 `fbbc52163f82e2e201e2d6bfe835e709f3f2abc2` 的内存中间层移植到 n3 基线 `6eab934e51721a13f9b2537eca670ccffe0cb31d`。当前 n3 gateway 尚无 `memoryAdmission` 注入，本次不迁入旧 gateway 接线；模块存在不代表已启用。物理2GiB仍须VM owner交付可信运行硬帽回读，常量、配置、RSS、guest `/proc/MemTotal` 或合成测试都不能替代。宿主压力source、全域启动门禁和shell外OOM观察仍须owner接实，真实排队/恢复与容量验收未完成。

## 公开合同与五面

公开入口`@allrice/vm-memory`（包0.1.0、`VM_MEMORY_CONTRACT_VERSION=1`），仅import `@allrice/person-vm` 公共barrel中的 `PersonVmBinding`。本次合同来自上述历史fbbc源码；allowlist在`packages/vm-memory/src/index.ts`，具名type/error在`src/contract.ts`，方法在`src/admission.ts`和`src/guest-config.ts`。历史 `7d13ffc39bc6583bf9ecc4bf1f352116879a0952` 曾固定旧gateway装配，不是当前n3的装配证据。可信observer、hardcap回读及owner实际启动/命令关联仍待公开交付；已有type不等于装配完成。

| 面        | 明确归属                                                                                                                                                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 后端      | `VmMemorySource.watch(binding,signal)`、`VmMemorySourceWatch.read/wait/close`是宿主owner必须实现的可信观察接缝；`createVmMemoryAdmission(source)`返回`VmMemoryAdmissionPort.watch`和`VmMemoryAdmissionWatch.read/wait/close`，只做外部资源门卫。`VmMemoryObservation`/`GuestMemorySample`为具名只读projection，无DB表/持久Agent状态。 |
| MCP       | none：无内存管理、pressure发布或VM重启工具；模型命令继续原生bash。                                                                                                                                                                                                                                                                    |
| 员工UI    | none：没有新设计；复用原生stdout/stderr/退出码与LlmError失败。                                                                                                                                                                                                                                                                        |
| 后台UI    | none：没有管理页面；资源事实由后续监控通过公开投影消费。                                                                                                                                                                                                                                                                              |
| 权限/开关 | 门卫按VM/person/org/instance/leaseEpoch全量绑定；未来gateway接线须保留其现权校验。当前n3未注入该门卫。无独立企业/员工开关或资料授权，资料级别none：仅宿主运行诊断；员工不可自行启用。                                                                                                                                                 |

allowlist：`VM_MEMORY_CONTRACT_VERSION`、`VM_PHYSICAL_MEMORY_BYTES`、`VM_MEMORY_PHASE4_REFERENCE_POLICY`、`VmMemoryPolicy`、`VmMemoryError`、`VmMemoryErrorCode`、`GuestMemorySample`、`VmMemoryObservation`、`VmMemorySource`、`VmMemorySourceWatch`、`VmMemoryAdmissionPort`、`VmMemoryAdmissionWatch`、`createVmMemoryAdmission`、`createVmMemoryGuestPlan`、`VmMemoryGuestPlan`。guest工件由`createVmMemoryGuestPlan({persistentDirectory,policy,policyRef})`返回，消费者不deep-import脚本实现。没有通用object/any、guest身份输入或跨模块SQL。

| 方法                                                              | 入参/结果/错误与调用方                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createVmMemoryAdmission(source)`                                 | host-only `VmMemorySource` → `VmMemoryAdmissionPort`；不执行guest/模型、不建额外身份。                                                                                                                                                                                                                                  |
| `VmMemoryAdmissionPort.watch(binding,signal)`                     | host-only `PersonVmBinding`、原生`AbortSignal` → `Promise<VmMemoryAdmissionWatch>`；错误`VmMemoryError`或原signal取消。source建立后若已取消，先等close再返回取消。                                                                                                                                                      |
| `VmMemoryAdmissionWatch.read/wait/close`                          | 无guest业务入参；read同步返回`ready/queued`或具名错误；wait返回通知的`Promise<void>`并沿原signal取消；close幂等，所有调用等待同一真实detach Promise。没有业务幂等键或副作用重放。                                                                                                                                       |
| `VmMemorySource.watch`及其`read/wait/close`                       | 相同host binding/signal；read返回`VmMemoryObservation                                                                                                                                                                                                                                                                   | null`，其他返回`Promise<void>`；source必须先订阅并缓冲通知、在失效时notify、honor取消和真实close。owner实现尚未绑定，不能由guest实现此权威口。 |
| `createVmMemoryGuestPlan({persistentDirectory,policy,policyRef})` | host选择的guest加密盘绝对路径、完整`VmMemoryPolicy`与已批来源`policyRef` → `Promise<VmMemoryGuestPlan>`；缺来源`approved_memory_policy_required`，非法policy为`invalid_memory_policy`，非法目录为`invalid_guest_memory_directory`，工件读取失败保留原错误。仅生成计划，无stream或执行副作用，不能从模型参数取宿主路径。 |

兼容规则：wire/model消息保持DSH当前单代及gateway v1。未来host/gateway接线须明确注入memoryAdmission并验证未交事实不能放行；当前n3尚未接入，本次不改变gateway签名或宣称其已获得内存保护。新旧guest工件按同一发布树/contractVersion固定，初始化拒绝不支持的版本，不并存两代DSH。私有数据仅进程内订阅/最终尝试错误和guest资源配置，无新DB模式；诊断投影不是Agent事件/状态机。

## 参数与可信观察

`VmMemoryObservation`所有顶层字段必填。`physical.configuredBytes/enforcedBytes`必须都是外部provider核实的2147483648；`enforcedBytes`不是RSS或guest自报。`binding`精确匹配当前host epoch；`revision/evidenceRef`非空。`host.vmRssBytes/helperRssBytes/swapBytes`分别为非负安全整数或null，null表示未知，不能计0。`guest`可null，所有guest计量只是可篡改诊断。压力决定`normal/pressure/unavailable`由VM外受管observer提供；类型形状及字符串不建立信任，禁止把guest JSON、请求header或原生日志直接包成source。

source订阅先于读取，通知缓冲；source负责断连、失效、takeover及退出时将事实标unavailable并通知。没有本包默认TTL、轮询、阈值、队列长度或等待超时。缺观察/失效、错binding、错cap分别返回`VmMemoryError`的`MEMORY_OBSERVATION_UNAVAILABLE`、`MEMORY_BINDING_INVALID`、`VM_MEMORY_CAP_INVALID`，原生LlmError沿同code及可读说明返回，不向ApiError.details塞任意VM数据。source必须遵守AbortSignal、close幂等并等待自己实际detach；客户端取消不是未发生副作用的证明。

参数没有产品默认，必须由宿主显式传入`VmMemoryPolicy`和实际批准/config release的`policyRef`；该字符串不授予批准，owner仍须核来源。缺参数批准来源是装配阻断，不能用样机批准替代。`VM_MEMORY_PHASE4_REFERENCE_POLICY`仅供历史对照/显式fixture。Linux入参校验保持字节非负整数、正swap长度、原生oom_score_adj范围和high≤max；command oom.group=0是本方案EXIT trap的局部回执前提。历史样机参数出处：`sandbox-research-20261120/PHASE3-AUTHORIZATION.md`、`PHASE4-AUTHORIZATION.md`及phase4 `setup-memory.cjs/start-web.cjs/bash-guard.sh`。2GiB磁盘swap；DSH low256MiB、swap.max512MiB、oom_score_adj=-900；命令父组high768MiB/max1280MiB/swap.max2048MiB/oom.group=0，child同RAM/swap，命令oom_score_adj=800。phase4真实OOM另把单child RAM/swap各设256MiB，仅验证该受限样题，不是默认值的容量证明。样机192MiB、700MiB+128MiB判压、250ms轮询/180秒超时未冻结成平台配置，本包不采用。

## 调用、取消、并发及未知

以下gateway行为是历史fbbc接线与未来装配要求，当前n3未交付，本次没有修改或验证其HTTP路径：模型fetch先等内存，再申请已有全局person 8路；容量恢复后再核内存和现权。每个模型SDK retry都重复该过程。auth-refresh须保留#903原生事务/落盘/独立取消合同，已开始的refresh不按模型压力中断。当前模块回归仅检验公开门卫合同。

未来接线须保留历史fbbc的以下约束：slot提交期间压力变为queued时，先持久结算`dispatchObserved:false/outcome:canceled`并释放此slot，再回内存等待，下一次新intent使用新ID。没有HTTP被发送；既有usage按false排除，所以不计作模型调用。结算失败保留原unknown slot并失败，不在占用slot时等压力。开始实际HTTP之后不因新压力强杀该流，取消/撤权继续等实际transport收尾。source订阅覆盖最后同步read到dispatch之间，避免异步close打开新窗口。

原生SDK可能把fetch异常变为自己通用错误终态；历史fbbc的transport处理（当前n3未迁入）仅保留最终model fetch的memory failure，drain之后返回具名错误；后续原生retry会重新准入并取代先前失败，成功及usage不能被首次拒绝覆盖，auth-refresh不取代模型尝试结果。文案仅描述该次被拦的模型尝试，不声称整个调用从未发送；ledger失败仍优先。固定DSH 0.2.1-rc.2的pi-ai适配层本身传maxRetries=0；历史fbbc测试另以公开pi-ai Codex API显式开启一次重试，验证当时的通用transport保留原生重试语义；不是本次n3门卫测试覆盖。未知账本保留既有恢复门禁，无TTL自动释放/原生call重放。业务operation/账本、原生日志/工作文件/employee配置与VM盘一同纳入BOUNDARY-CONTRACT第7节恢复集合。观察是当前外部事实，重启后须重新建立，旧快照不是当前压力权威；不会恢复“允许”缓存或重发命令。

待owner实际装配并验证的启用顺序为：核当前本人/epoch及已批平台资源policy→provider实核物理cap→stage/initialize成功→建立可信source→显式注入gateway→原生runtime就绪；本片没有开启4.0。关闭/撤权由宿主先`gateway.revoke(binding)`取消等待及实际请求并等待owned drain；source同时invalidate/notify，关闭所有订阅后VM owner再停机。更新/删除沿owner当前epoch与原生配置生命周期，本模块不删盘、不创建线程。事件投影仅资源诊断，streamRef=none（通知不是原生会话事件流，没有自建游标/重建执行）；source revision/evidenceRef供旁证关联。恢复后重建当前source，副作用未知仍走既有账本对账。

## Guest工件与原生接缝

`createVmMemoryGuestPlan`返回文件、显式initialize命令、launcher和环境；生成工件无副作用。VM owner只将它们stage到本人加密持久盘；必须在starting owner持有覆盖所有合法入组来源的门禁、原生DSH launch之前，执行Linux guest root initialize并回读swap/memcg，成功后才释放启动边界并以`/bin/sh <launcher> <原生DSH可执行文件> ...原argv`启动。launcher在exec前进入DSH组并设置policy中的OOM优先级，原生bash继承BASH_ENV，shell在每命令child组设置对应命令优先级（phase4参考分别-900/800，非本模块默认）。原生DSH仍负责工具调用、超时、进程取消、stdout/stderr、退出码、会话和继续，无第二shell executor或私有DSH接缝。

初始化拒绝错误已有swap、不重格式化活动swap；所有组先读cgroup.events populated（包含后代）并预检，才写新组限额；现存组差异限额即使空也拒绝，同配置限额只读校验，不提供running重配。populated=0不能阻止下一刻新命令入组，首次新组初始化仍必须由owner门禁覆盖check+write+readback。已有bootstrap plan/managed launch候选不等于实际所有合法来源受同一fence约束；本模块没有该全域保证，R1-02尚未整体关闭；仅传starting字符串、调用running-only resolve/assertCurrentBinding或raw class.exec不能替代门禁。失败退出75。原生bash EXIT trap按自己的`memory.events.local`增量判断OOM；`oom_kill`来自任何OOM killer，只有同时见本child的`oom`增量才称`COMMAND_MEMORY_LIMIT`，否则`COMMAND_OOM_KILLED`明确原因需核。137本身不当OOM。局部OOM复用样机中文说明和137，不制造原生isError/成功或执行第二遍。同PID的exec bash重入先验证进程starttime、当前统一cgroup路径和相同限额，再复用首次导出的数字OOM基线；不会mkdir -p或重置基线，身份/配置不符则拒绝。该验证是guest root协作事实，不授予外部身份。退出前移出child再删除空组；仍有后代时组保留，native进程owner须真实收尾，不能为了清理回执杀未知任务。

R1-04仍未关闭：EXIT trap仅在shell存活且仍拥有trap时尽力生成解释。合法exec node/python替换shell，或shell自身遭SIGKILL/OOM时，不能靠trap自动解释；必须保留原生exit/signal与会话事实，不能把137/SIGKILL猜成OOM，也不能用共享父组计数增量归因并发单命令。自动可读局部OOM要求仍保留，尚未兑现全路径覆盖。

已核DSH 0.2.1-rc.2公开SubprocessHandle.done/terminate/waitForExit、ShellExecution.done/result/observed及tools/post-execute/result；它们提供精确原生命令的退出/输出或tool outcome，但没有普通child的可靠PID birth/cgroup/OOM关联。最小拟议上游接缝须由现有native process owner在同一execution范围创建并持有唯一command resource关联，在入组前取本child baseline，完成/managed range收束后由被执行shell之外的owner读取本child计数，并返回可核的关联及未知状态；不改写原始退出、取消、输出或工具成功。并发child、存活后代、exec替换和shell死亡都须纳入该公开合同。这里不臆造签名、不接private handle、不另造executor或服务，待原生owner公开冻结后再实施。

guest内保留root，配置可被改写/绕过，不构成员工隔离或外部授权。low是尽力保护，-900不是绝对免杀，父组/全局OOM下不能承诺任意负载会话永活。[Linux cgroup v2文档](https://docs.kernel.org/admin-guide/cgroup-v2.html)规定high主要慢化、max触发局部OOM、swap.max单独限制交换；events.local避免把后代事件当父组局部事实，oom_kill本身不能证明哪级触发OOM。

## 验收与移除边界

本次n3移植的受影响测试是本包admission.test.ts与guest.test.ts；历史fbbc的HTTP→原生provider→loopback上游测试没有迁入或在当前n3重跑。合成source覆盖cap缺失/unknown不能由configured/RSS/guest值补齐、setup取消后晚到watch的真实detach、并发close、断连/旧epoch/压力恢复；guest测试用合成sysfs与短bash核初始化回读失败、exec非shell/自身SIGKILL/计数不可读时不猜OOM。这些不是可信producer、全域fence或shell外exact completion的实现证明；无真实模型、VM、PG、浏览器、QA/压力分配。普通单测保留原收集方式与旧断言，实际运行、首败、计数及资源清理以本卡本轮QA回执为准。

历史快照：MET266 `bb38e59e07146a0cb5928d066f4591b327b47e82` 当时公开的MicrosandboxPersonVm/PersonVmNativePort/PersonVmRuntimePort及class.exec仅有底层入口。后续c35/f0c已交 `PersonVmRuntimePort.memoryGuestPlan/start`、`PersonVmBootstrapScope.launch`、managed Job `wait/cancelAndWait` 等bootstrap/managed launch公开口，本模块可消费；它们不等于已证明实际所有合法入组来源的全域fence，也未交可信运行cap回读或shell外exact child/OOM关联。MemTotal、ps、配置inspect或可能fallback配置的metrics不填enforcedBytes。owner后续增量单独收敛，本次未跨树迁入。

仍待各owner公开冻结并实际接入：物理cap运行证明、经批准的平台swap/memcg/OOM参数与来源、全域starting fence、guest初始化/launcher挂载、shell外exact child completion、可信外部observer和判压来源；仍待父线真实测：多线程压力/排队，局部、命令父组、全局OOM及恢复、同会话原生日志保持、host helper额外RSS/swap、CPU/容量包络。未通过不能报整卡/模块迁入或“可慢可排队、不能杀会话”已验收。没有删除任何原生功能。MET-225新增行`allrice-vm-memory-v1`交父线登记，监控owner须对observer失效和OOM诊断补真实告警接线。
