# D 入口公开合同（MET-271）

离当前目标还差什么：cookie身份HTTP入口、不可变产品代际、共享发布配置、4.0 root claim/pin 与跨进程现权通知已接入；真实4.0 HTTP/WS/profile受管目标和完整执行owner仍未绑定。4.0 admission返回503，不能当已挂客户端或已开启Dev开关。UI接线由打野3完成，本文不改变可见界面。

本合同复用API v1、`ContractVersion=1`，与冻结的M1-01 v1.0一致。DSH包保持单代`0.2.1-rc.2`；`ExecutionGenerationSchema`的3.x/4.0是产品writer归属，与DSH的distributionGeneration、原生thread_generation无关。

## 身份与实际HTTP入口

`GET /api/v1/d-entry/identity?workspaceId=<uuid>&employeeInstanceId=<uuid>[&threadId=<uuid>]`

只使用现有`allrice_session`的httpOnly登录cookie及既有portal校验。tenant/workspace header仅沿现有认证作受验证的选择器；person取登录actor.id。query为`DEntrySelectionInputSchema`，拒绝额外字段和重复参数。employeeInstanceId是本人当前实例ID，不是模板ID。带threadId时，员工必须等于该根会话的现有实例归属。

200结果为`@allrice/contracts#DEntryIdentityResultSchema`：

```json
{
  "identity": {
    "organizationId": "uuid",
    "workspaceId": "uuid",
    "personId": "uuid",
    "employeeInstanceId": "uuid",
    "employeeRevision": 1,
    "employeeVersionId": "uuid",
    "threadId": "uuid or null"
  }
}
```

上述UUID字符串是字段说明，实际值须通过UuidSchema。无threadId时只允许有效员工；带threadId的本人冷历史沿`getEmployeeInstanceForHistory`和`authorizeSessionHistoryOwner`保留归档/撤配读取，但不授执行。当前员工服务每次核session/user/membership，历史接口也不能绕过登录或当前租户权限。

执行分支另调用身份owner公开口`@allrice/database#requireCurrentWorkspaceWriteAuthority(context, workspaceId)`，实时核有效登录session、active用户、未归档租户/空间及当前admin/member资格。旧RequestContext里的member快照不能覆盖已降为viewer的现状；无thread新建准入同核，降权仍保留本人历史读。失败沿现有`AUTHORIZATION_DENIED`/403，不变更登录或历史错误合同。

`POST /api/v1/d-entry/admission`使用同一选择器JSON、现有cookie并要求真实同源Origin。先核当前员工/root可继续权限，再读显式发布policy。成功选择结果为`DEntryAdmissionSchema`（identity、executionGeneration、policyRevision）；已有线程以永久pin为准，名单选择只作用于新线程。4.0名单被关闭后，4.0旧线程拒绝继续，身份历史入口仍按当前读权可用。

**当前边界：** 发布配置已使用下述共享平台来源；缺配置明确关闭4.0，3.x admission 返回既有选择结果。已发布且永久 pin 为4.0的 admission 仍因真实 native route 未组合返回503；未发布4.0拒绝继续。不会创建线程、启动VM、刷新模型凭据、发prompt或回落到3.x执行。

错误全部沿`ApiErrorSchema`；401 AUTHENTICATION_REQUIRED、403 AUTHORIZATION_DENIED、404 RESOURCE_NOT_FOUND、400 VALIDATION_FAILED、409 EMPLOYEE_INSTANCE_ARCHIVED/VERSION_CONFLICT、503 DEPENDENCY_UNAVAILABLE。响应`private, no-store`；不返回guest URL、AllRice cookie、模型秘密、盘路径或任意error.details。

## 发布配置与产品代际归属

`DEntryRolloutPolicySchema`保留显式revision、defaultGeneration、selections；每条selection为完整organizationId/personId/employeeInstanceId/generation，重复tuple拒绝。共享来源是现有 `allrice_settings` 的 system/null/`d_entry_rollout_policy`，沿 `native_question_mode` 平台管理方式。无新表/字段/env/管理UI。缺行返回 `{revision:"unpublished",defaultGeneration:"3.x",selections:[]}`；发布服务只接受默认3.x，只有精确本人/员工条目可开启4.0。当前没有实际名单被写入任何环境。

`GET/PUT /api/v1/admin/d-entry-release-policy` 只走现有 platform-admin cookie/同源写门卫，PUT body 为该 policy schema；revision由服务端生成，客户端revision不能授予权限。`@allrice/database#getDEntryReleasePolicy/updateDEntryReleasePolicy` 使用身份owner的 `requireCurrentPlatformAdmin`，最终写事务持当前session/user SHARE锁，与撤权/停用排序；写入既有 audit_events。配置非法或DB不可用不启用4.0。`readDEntryReleasePolicy` 是宿主内部只读口，调用方先核真实登录/员工；不向guest暴露全名单。

`allrice_chat_sessions.execution_generation`由0249迁移加入；已有线程/3.x创建是3.x，4.0创建由可信宿主调用`createChatSession(...,{executionGeneration:'4.0'})`同事务写入。该options不是浏览器body。DB trigger禁止更新pin；固定ID幂等重试必须匹配代际。4.0创建不伪造3.x native_root_origin。后续VM/native root绑定由各owner公开口完成。

旧send/steer/问答/queue edit/自动任务producer经现有message/queue事务门卫；3.x claim过滤4.0，start/native prepare/bind、native runtime acquire/owned writes与网页子控制再核pin。不按可变名单改旧线程，不改DSH出生元数据，不增Agent状态、自动重放或回退迁移。

旧PATCH会话的title/visibility/archive/pin和messages.visibility写入均只允许3.x。旧附件POST/PUT在分配存储ID、metadata与blob之前调用公开口`authorizeLegacySessionWrite`；`linkFileToSession`和`linkWorkspaceFileToSession`最终写点独立核pin，读取历史不受此门卫影响。本地附件的旧command入队、local.file设备claim、实际transfer前同核3.x，不能先上传再以link失败收尾。无session的旧设备文件功能保持原语义。

旧once/recurring（含monthly）登记与执行门卫核**源线程**3.x；`new_each_run`在新建目标前复核源pin，后续job准入同时核冻结source和target的3.x pin。不能以创建一个新3.x目标替4.0源线程执行。所有检查复用不可变出生pin，不增clock或产品状态机；3.x原有定时能力保留。

迁移只作用现有线程owner表，发布前必须停旧writer、做迁移快照并核旧版本兼容；旧binary不认识新pin，所以首次创建4.0线程前不能与旧writer同跑。代码不执行共享Dev迁移。

## 原生资源、子会话和流的宿主端口

`authorizeDEntryNativeResource`与`followDEntryNativeResource`是**尚待真实transport绑定的宿主门卫**，不是已公开给浏览器的RPC协议。`DEntryNativeResourcePort.resolve(identity,nativeSessionId,signal)`须由owner核宿主root pin及完整原生父子关系，返回同本人/员工/thread的native session、root、parent、bindingRef和host-only revoked AbortSignal；不能直接反序列化guest descriptor建立信任。

原生方法descriptor提供read/write effect。子会话只允许read；prompt/send/continue/edit/updateQueue/cancel/rename/fork/selectModel等任何write effect拒绝。主会话原生工具指挥不经过这个网页门卫。4.0 root网页写另核当前显式发布policy和员工准入；3.x旧网页controls继续走原有语义。

流的`open(resource,signal)`必须把signal传到真实I/O。初始host revoked signal与request取消相连，所以空闲无新chunk时也会中止实际reader；每个chunk输出前再核当前cookie/membership/员工/root/4.0 pin与binding，失败先abort再等待iterator.return。已经返回的字节不能收回。不新建撤权轮询或计时器。

正式依赖：MET-266固定头`abf556870b4454ebbdf1833ad1e35b0fef11a884`的`@allrice/person-vm#PersonVmPort.resolve/assertCurrentBinding`已公开当前本人/租户/VM epoch生命周期绑定；该头仍没有HTTP/WS/profile目标。目标与受管连接、实际撤权signal、原生root关系口还须各owner发布；不从其内部表/代码偷取、不猜端口/secret、不向VM转发AllRice登录cookie。

## Native Web 入站 consumer

Web/Worker共用 `@allrice/database#resolveDEntryIdentity`；Web旧文件保留薄导出。`requireDEntryNativeIdentity` 对所有VM-live读写核当前可写资格、精确发布名单和线程4.0 pin；冷历史仍沿原 history 服务，不开机。Worker在原Bearer真实认证后重新调用该服务，不接受浏览器 RequestContext、person、VM、endpoint或effect。

| Web公开同源POST / Upgrade         | body / query                                                            | 结果                                                                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/v1/d-entry/native-owner`    | `DEntrySelectionInputSchema`                                            | `{mount:DEntryMount,controlReady:boolean}`；mount含opaque bindingRef/remountKey，不含receipt/端口/原生Cookie。不是editor-ready/canSend。 |
| `/api/v1/d-entry/native-resource` | `{selection:含必填threadId的选择器,nativeSessionId}`                    | `DEntryNativeResourceFactsSchema` 安全事实；不序列化revoked signal。                                                                     |
| `/api/v1/d-entry/native-rpc`      | `{selection:含threadId,endpoint,payload:{args:原生生成参数}}`           | 原生RPC body/content-type；不转发Set-Cookie/Location。不是任意URL代理。                                                                  |
| `/api/v1/d-entry/native-mux`      | GET WS，query只有organizationId/workspaceId/employeeInstanceId/threadId | 同listener的具名Upgrade；先经原Web cookie/portal现权探测，再把原Bearer只送固定Worker，禁止redirect。                                     |

Worker同listener对应 `/internal/d-entry/native-owner`、`native-resource`、`native-rpc`、`native-root` 的POST和 `native-mux` Upgrade；POST加宿主当前organizationId，其他字段同上。Worker内部HTTP拒绝浏览器Origin，重新authenticateSession原Bearer，核当前员工/可写资格/发布/代际后才调用owner。RPC先验证登录，再缓冲native body；不把浏览器身份JSON或AllRice Cookie送guest。错误沿ApiError：401未登录、404不可见/失权、400请求非法、503依赖未装配；Web自身当前现权沿原403。所有结果no-store。

`DEntryNativeOwnerPort` 是271对冻结v1的消费接口；`dEntryOwnerViewSchema`只解析该宿主投影，**不是273新receipt发行器或同名替身package**。273正式receipt导出/生产装配由其owner提供。`installDEntryNativeOwnerPort` 仅进程内组合注册，无person/lease Map或权威；默认未注册503。`readSessions`直接使用rc.2公开 `RemoteResult<SessionListValue>` 与真实生成result codec，原生失败保留code/message/details。

资源组合只读0251既有chat行的不可变4.0业务pin，经 `getDEntryNativeRootPin` 安全投影，与native catalog完整parent链核对；拒绝跨root、跨持久VM/profile、循环、重复ID、缺parent、换pin及失权。该读取不创建/修复pin。显式根创建另走下述可信宿主producer；4.0旧origin仍为NULL，旧binder只准3.x，不会挑列表第一项、改旧origin或用浏览器root。

数据面另需真实host注入 `DEntryNativeDataPort`：同一c041 boundary/entry participant、完整原业务envelope resolver，以及同步取得的每请求owned RPC/Mux handle。run内开始I/O，close主动取消并join部分初始化和全部子操作；不能用长期native job.close代替每请求close。失败未拿到handle保持callback rejection；业务/合作取消在实际join后fulfiloutcome，最外层finally finish后保原错。catalog的实际readSessions Promise仅在admitted callback的owned scope内启动；scope主动取消并join所有真实读取，raw reject没有单独joined-close事实时保持unknown。HTTP/Mux shutdown等待实际请求/reader/transport和finish，不用socket.destroyed或单个iterator.return宣称全域完成。

Mux逐逻辑open消费rc.2公开frame parser与 `TYPERT_REMOTE.input({strict:true})`，再按源码逐项登记effect；每次native下行也核当前资源。prompt/queue edit/cancel/rename/selectModel仅root；child无论continuable与否都不可网页写。当前无uplink方法被接纳，未知/global/plugin/`$events/result`全部拒绝，不能通过opaque WS或事件答复绕child门卫。父会话在原生内部的工具指挥不经过此网页adapter，3.x入口保持原断言。

公开descriptor没有effect，`$events/result`只给opaque event关联；v1没有agent/event→SaaS root归属、全局control/list安全投影或native数据面借用。不能因此声称原生页面已完整可发。生产transport/full-envelope、cold/first-prewarm及physical fence未组合；未安装owner/data时503。测试替身只核consumer调用/真实JS关闭Promise，不证明PG sticky unsafe或VM物理fence。

`POST /api/v1/d-entry/native-root` 只接受 `{selection:{workspaceId,employeeInstanceId,threadId}}`；同源原cookie到固定Worker的原Bearer，Worker同listener `/internal/d-entry/native-root` 重新认证。只对已批准4.0线程显式创建，history/discovery不创建或开机。成功返回同 `DEntryNativeResourceFacts` 的普通根（nativeSessionId=rootNativeSessionId，parentNativeSessionId=null），没有端口/native auth；资格/依赖错误沿既有401/404/503。Web/Worker不接收native id、preset、path、receipt或root为创建权威。

271在同一admitted callback调用可信data port新增 `acquireRoot({owner,request},signal)`；构造handle不启动I/O，run才调用rc.2生成codec构造的create，真实handle覆盖partial init、native reply和close/join。`ensureDEntryNativeRoot` 在短事务锁定当前身份/员工/Session/发布配置，以同一chat行锁串行领取完整scope的不可变claim，确认提交ACK后才允许原始callback唯一dispatch；第二短事务同claim及完整现权下落真实回执pin，不再持独立advisory连接锁。最终政策按本人/员工当前资格核验，整份名单的无关revision更新不使其失权，出生revision仍保留。提交ACK不明、create结果未知或最终落盘失败时保留claim，后续同键/换键都不再次create；claim不等于创建成功、pin不可读，沿既有503依赖未就绪合同，无TTL/自动恢复/重放。pin实际提交但回复丢失时只读既有pin，不再create。保完整出生scope/release/host provenance；持久vmId+employee instance/profile关联不因临时instance/epoch/bindingRef变化重写，不生成Run/Job或legacy origin。实际owner须将selected endpoint映射到同一持久员工profile。

`watchDEntryNativeAuthority` 使用新增精确锁定pg 8.23.1的Client公开事件订阅0251同事务提交通知，先LISTEN再重核全部当前资格；通知只触发SQL复核。session/user/membership/org/workspace/员工分配/instance/发布及rollout来源变化均覆盖；自然过期按真实expires_at关闭，通知error/end保守abort，关闭等待已经开始的复核。HTTP/WS默认真实接入此source，273的owner revoked仍独立合并。pg仅持通知及根创建并发门卫连接，业务SQL保留既有postgres.js，不新增共享权威或轮询。管理员发布名单不能安装owner/data或绕过完整admission resolver；数据面还核controlReady作为必要前提，该值true仍不授editorReady/canSend。真实PG测试与受影响完整文件由主线M5执行，本实施阶段未跑。

## F4 生命周期共用服务

`@allrice/person-vm` 在本树仅携带 #905 `c041d94c6984463c9ff9a068cba0db58ebc91e16` 的公开合同与构建基座；barrel 不导出 host/service/store/provider。模型 owner 已回交该中间 producer 的独审及 PG 测试结果，本树仍未组合真实 Host。`admission-contract.ts` 仅作显式格式派生，QA 保留源/派生 blob、diff 及原 8115 首检。不能用这份切片或 consumer 测试替身声称本树 PG 准入、停机或恢复已通过。

`runDEntryAdmittedActivity({ports,owner,signal,queued?},acquire)` 只消费同一 model composition 注入的 `PersonVmAdmissionBoundary` 与 `participant('entry')`，不构造 SQL/Host。owner 持有原完整业务 binding，并提供当前身份、员工 release、Run/execution/thread/native instance/profile/root/parent/session/call、代际与模型 route 的实际校验；deferred 续行还须真实 owner 证明原调用从未 dispatch。没有默认 checker 或从 guest JSON 建立的 owner。

每个连接/typing/prewarm 的完整 owner 在 entered callback 内交 `DEntryOwnedActivity`：`run(signal)` 执行业务，`close()` 触发取消并返回覆盖部分初始化及全部受管子操作的**实际 joined-close Promise**。owner 必须把 signal 传到真实 I/O。consumer 在取消和收尾时只调用一次 close，并等待该 Promise；AbortSignal、单个 iterator.return fulfilled 或无触发的 Promise 都不证明全域 owner 完成。

callback 内先核 abort、完整现权，await 后再次核 abort，才可 acquire/open/start；此阶段失败不伪造 joined handle。拿到 handle 后的业务/合作取消错误只有在实际 close 完成后才以本地 outcome fulfil callback，最外层 finish 后重抛原错误。open/start 拒绝、close/join 未知直接 reject callback；业务或取消 E 后 close C 未知以 aggregate `[E,C]`/cause 保原错。所有路径仍 finally finish，finish 再拒绝继续保原链，不能报释放成功。c041 producer 对 entered callback 拒绝保留 sticky unsafe，即使外层捕获内层拒绝；其真实 PG 保证不由本片测试替身模拟验收。

freeze 前 queued 保留原 permit；freeze 后 deferred 依次 waitUntilReady、finish 旧 permit、重核完整原 binding 和从未 dispatch、重新 admit。新 admit 使用 caller/native owner 的根 signal，不能复用 finish 已 abort 的旧 permit.signal；相同 epoch 也必须换 permit，但不创建新 Run/call/claim。新 VM epoch/owner/业务绑定失效则取消旧执行，不改标签或重放旧 handle/claim。

`runDEntryNativeActivity` 是完整 VM-live 操作的宿主准备 hook：保留 root/child 与现权门卫，额外核 4.0 执行准入，并消费上述真实 owner handle。实际 native/execution owner 还须以 `assertResource(resource,signal)` 将准确 descriptor 核回原完整 envelope，不能各自授权两个对象后假定同属一个调用。现有冷 history/read/follow 不调用它，不 wake。实际 transport、全 envelope owner、connection/typing/prewarm close producer、starting owner scope、冷/首次 prewarm 和 exact physical fence 均未提供；正式 HTTP admission 仍明确依赖未绑定，未挂可用 4.0 Client。不能先 prewarm 再补 permit，不能自行 mint 尚 proposed 的 starting binding/signal/assertCurrent。

本片不加组织停用流程、恢复 API 或状态表。MET274 历史/下载的取消 join 不是 whole-owner physical fence；existing recoverExpired 仍先经可信 stop 授权，不能从 guest 暴露 raw store/no-op recovery，也不能伪造 now/TTL 绕 expiry。

## 给打野3的客户端重挂合同

宿主`dEntryClientMount(identity,executionGeneration,runtimeBindingRef)`生成`DEntryMountSchema`。runtimeBindingRef由真实受管Host/profile/lease提供；native-owner发现口只在注入真实owner后返回mount投影，不等于可发送。`remountKey`的SHA256输入按顺序为organizationId、personId、employeeInstanceId、employeeRevision、employeeVersionId、executionGeneration、runtimeBindingRef。

UI把remountKey作为DSH Client根的key：key变化时先abort所有旧HTTP/WS/资源流、release旧SessionReference、销毁旧Client/Cordis root，再以新准入挂新Client。同Host内普通thread切换可使用原生session retain/open语义，threadId不参与remountKey。失败保留未挂载/不可用状态；重连重新取cookie准入，不缓存旧RC为永久权限。只调用openSession不等于跨Host切换完成。

本票只提供key/数据/服务门卫；真正UI abort/dispose/remount、亮暗×桌面手机截图与原生只读右栏验收归打野3及节点4，当前没有这些结果。

## 直接受影响验证

单文件快测`apps/web/lib/identity/d-entry.test.ts`覆盖真实route handler边界、显式policy/永久pin、child写拒绝、逐chunk现权、idle撤权signal收尾和remount key。`d-entry.integration.test.ts`经真实cookie认证/隔离PG验证跨租户/人、旧RC降viewer、撤权、冷历史、不可变pin/竞争创建、legacy send/queue/claim/start/prepare拒绝；还经实际PATCH/附件/once/recurring handler验证4.0零写及3.x正向。`local-files.integration.test.ts`新增真实设备/文件夹夹具下的4.0拒绝入队、claim、上传及3.x原上传回归。集成门禁由主线M5运行，未跑不能报通过。

旧native-subagent-authorized-query、native-subagent-control、native-session-binding/generation、employee-instances、message route、conversation-input/queued-messages/runtime、task-native-wait和run-delivery-authority相关完整文件必须一并由主线核受影响范围。Astra xhigh绑定确切提交。无真实模型Run、VM启动、共享Dev迁移、部署或本人验收。

MET-225待主线登记：4.0入口门卫限定网页子会话只读；DSH native parent控制不变；原生session/stream/descriptor语义保留，新增仅现权门卫和产品单writer存储。3.x既有控制记录不删除，不把本候选登记成已发布。
