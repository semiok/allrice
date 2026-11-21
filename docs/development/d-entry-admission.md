# D 入口公开合同（MET-271）

离当前目标还差什么：cookie身份HTTP入口、线程不可变产品代际pin和3.x写入门卫已实现；批准发布配置来源、4.0 HTTP/WS/profile受管目标尚未绑定。4.0 admission返回503，不能当已挂客户端或已开启Dev开关。UI接线由打野3完成，本文不改变可见界面。

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

**当前边界：** `readDEntryReleasePolicy`刻意返回依赖未绑定，不读猜测env、空名单或自设默认值。以后配置接通后，3.x admission可返回既有选择结果；4.0仍因native route未绑定返回503。不会创建线程、启动VM、刷新模型凭据、发prompt或回落到3.x执行。

错误全部沿`ApiErrorSchema`；401 AUTHENTICATION_REQUIRED、403 AUTHORIZATION_DENIED、404 RESOURCE_NOT_FOUND、400 VALIDATION_FAILED、409 EMPLOYEE_INSTANCE_ARCHIVED/VERSION_CONFLICT、503 DEPENDENCY_UNAVAILABLE。响应`private, no-store`；不返回guest URL、AllRice cookie、模型秘密、盘路径或任意error.details。

## 发布配置与产品代际归属

`DEntryRolloutPolicySchema`要求来源显式提供revision、defaultGeneration、selections。每条selection为完整organizationId/personId/employeeInstanceId/generation；重复tuple拒绝。实际载体、管理来源、默认代际和本人名单由发布负责人绑定，当前没有新env、配置表或管理UI。

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

## 给打野3的客户端重挂合同

准备就绪后，宿主`dEntryClientMount(identity,executionGeneration,runtimeBindingRef)`生成`DEntryMountSchema`。runtimeBindingRef由真实受管Host/profile/lease提供；当前尚未生成正式mount响应。`remountKey`的SHA256输入按顺序为organizationId、personId、employeeInstanceId、employeeRevision、employeeVersionId、executionGeneration、runtimeBindingRef。

UI把remountKey作为DSH Client根的key：key变化时先abort所有旧HTTP/WS/资源流、release旧SessionReference、销毁旧Client/Cordis root，再以新准入挂新Client。同Host内普通thread切换可使用原生session retain/open语义，threadId不参与remountKey。失败保留未挂载/不可用状态；重连重新取cookie准入，不缓存旧RC为永久权限。只调用openSession不等于跨Host切换完成。

本票只提供key/数据/服务门卫；真正UI abort/dispose/remount、亮暗×桌面手机截图与原生只读右栏验收归打野3及节点4，当前没有这些结果。

## 直接受影响验证

单文件快测`apps/web/lib/identity/d-entry.test.ts`覆盖真实route handler边界、显式policy/永久pin、child写拒绝、逐chunk现权、idle撤权signal收尾和remount key。`d-entry.integration.test.ts`经真实cookie认证/隔离PG验证跨租户/人、旧RC降viewer、撤权、冷历史、不可变pin/竞争创建、legacy send/queue/claim/start/prepare拒绝；还经实际PATCH/附件/once/recurring handler验证4.0零写及3.x正向。`local-files.integration.test.ts`新增真实设备/文件夹夹具下的4.0拒绝入队、claim、上传及3.x原上传回归。集成门禁由主线M5运行，未跑不能报通过。

旧native-subagent-authorized-query、native-subagent-control、native-session-binding/generation、employee-instances、message route、conversation-input/queued-messages/runtime、task-native-wait和run-delivery-authority相关完整文件必须一并由主线核受影响范围。Astra xhigh绑定确切提交。无真实模型Run、VM启动、共享Dev迁移、部署或本人验收。

MET-225待主线登记：4.0入口门卫限定网页子会话只读；DSH native parent控制不变；原生session/stream/descriptor语义保留，新增仅现权门卫和产品单writer存储。3.x既有控制记录不删除，不把本候选登记成已发布。
