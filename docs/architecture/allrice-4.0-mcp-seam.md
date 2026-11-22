# MET-272：M1 原生 MCP 可联调接缝

当前交付是原生 SDK server、host 现权/代际/调用绑定和三模块 M1 公开子集。4.0 的 execution/receipt、issued memory pin/预算及 publisher carrier 尚待所属 owner 公开绑定；这不表示模块已迁入或 4.0 生产业务全通。没有启动入口、默认配置或企业/员工开关变更。

原 n3 接收基点为 `6eab934e51721a13f9b2537eca670ccffe0cb31d`，M1 封版 sourceAtSha=`13c1b201da4f04acdf35359785f59b4f0cedd3f8`，未携带旧 #899 入口权威。本 n4 M2 首片从该源增加可选接口，正式头由交接回执绑定，不改原 #902 封版树。公开源级入口为 `apps/worker/src/mcp/allrice-server.ts`。Worker 是 private 工作区，没有新增 package exports，不能把该文件虚构成 `@allrice/worker` 的子路径导出。业务 owner 的宿主适配器消费这些签名，数据库模块不反向导入 Worker 或跨 owner SQL。

## 具名 host API v1

`ALLRICE_MCP_CONTRACT_VERSION=1` 由宿主构造，`createAllriceMcpServer(AllriceMcpServerOptions)` 明确返回 `AllriceMcpServerPort`。端口的 `contractVersion` 和 SDK serverInfo.version 来自同一常量；它不是 guest header、权限凭据或业务 schema 版本。现有 CallToolResult/JSON Schema 不套新 envelope。

| 具名签名/方法                                                    | v1 保证和 owner                                                                                                                                                                                                        |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AllriceMcpBinding`、`AllriceMcpScope`、`AllriceMcpHost.current` | 宿主固定 person/org/workspace/employee/thread/native session/代际，每次重新取现权、config revision 和 native call。requestId/toolName 只是未受信选择器；271/273 仍须提供真实映射，类型和 schema parse 不认证。         |
| `AllriceMcpServerOptions`                                        | 可注入 host 和 `AllriceMcpServices`；没有 host 不发布工具，service/模块资格/代际不匹配不发布且执行时拒绝。未接的 4.0 carrier 不以 legacy adapter 补齐。                                                                |
| `AllriceMcpReferenceRead`                                        | `(scope, ReferenceReadInput, signal) → Promise<CallToolResult>`，精确等于现 `services.referenceRead` 签名。MET-281 owner 核资源、pin 和实际 receipt；不是完整 EnterpriseMaterialsPort。                                |
| `AllriceMcpMemoryRead`                                           | `(scope, {number}, signal) → Promise<CallToolResult>`，精确等于 `services.memoryRead`。MET-283 owner 核已 issued ordinal/pin、当前状态和真实预算；不提供任意正文查找或新预算。                                         |
| `AllriceMcpDeliverableCreate`                                    | `(scope, AllriceMcpDeliverableInput, signal) → Promise<CallToolResult>`，精确等于 `services.deliverableCreate`。MET-281 owner 负责真实字节、质量、版本、lease/CAS 和幂等 receipt；prepared 字节/授权不进 guest input。 |
| `AllriceMcpBusinessError`                                        | 仅已有 ApiErrorSchema / ReferenceSelectionErrorSchema 的 payload union，保留 code/message/retryable 和当前输入内的 revision IDs。正常业务失败仍用原生 CallToolResult.isError；不是所有 owner 错误的新统一 envelope。   |
| `port.server`                                                    | 原生 SDK Server，连接仍用 SDK `connect(transport)`；本片不包装握手、重连、重试或 MCP 执行器。真实 managed route/transport 的绑定和关闭证明仍归入口 owner。                                                             |
| `notifyCatalogChanged()`                                         | 原生 list_changed；客户端可能保留旧目录，所以不能替代每次工具执行的现权检查。                                                                                                                                          |
| `whenIdle()`                                                     | 仅等本连接已跟踪的 host/业务 Promise，不取消、不封新准入，不等同 revoke。                                                                                                                                              |
| `revoke()` / `close()`                                           | 同一幂等的 MCP 自有收尾 Promise：先封本连接新准入、abort 请求，再等待实际 host/业务工作完成，最后 SDK close。另一连接不受影响。可信撤权 owner 必须实际调用 revoke；仅提供方法不等于已接撤权通知。                      |

每个业务 callback 返回的 Promise 必须覆盖其真正 I/O/事务完成；不得用取消先返回而把工作遗留后台。原生 request.signal 与本连接 shutdown 合并，取消后不披露新结果，但已提交预算/版本/外部效果仍成立。协议错误沿 SDK McpError：无可信绑定为 InvalidRequest，参数不合法为 InvalidParams，未识别内部异常为脱敏 InternalError。未启用/未绑定工具用现有 DEPENDENCY_UNAVAILABLE/isError；执行后现权变化保持 AUTHORIZATION_DENIED，不暗示已提交成果回滚。

恢复只交原业务 owner 对原 call/digest/receipt 核实已发生事实；MCP 不自动重发、换 key 或恢复授权。无需新表、限额、TTL、模型 permit 或 Agent 状态。approval/bridge 继续只保留 namespace，不新增工具或外发权限。

代际依赖采用 271 owner 正式回交的 `c1aaee8017e960da1c64a8fa885c16a7bcbe895f:packages/contracts/src/d-entry.ts` 原字节（blob `5a2009a7a37b442e965af579f21f02de81b52897`），本树 contracts barrel 仅增加该文件 export；共同依赖 common.ts 与 n3 base 同 blob。没有合入旧 #899 或 271 身份/监听实现。`ExecutionGenerationSchema`/`ExecutionGeneration` 只校产品写代际，不证明当前身份、native call、VM ready 或生产装配。旧单文件缺导出的首败保留；新组合仍须自身门禁和独立增审，接口仍为 candidate，未正式验收。

## n4 M2 可选接口首片：6/7 注册

本片仅扩同一服务的六个可选 callback、具名 alias 和原生工具，`contractVersion=1` 不变；旧三 callback、四个既有工具 JSON 和取消端口保持。六项只消费 M1 源已有公开 schema，不实现业务。第七项 `deliverable_read` 等待 MET-281 正式 `DeliverableReadInputProjectionSchema` 交接，本片无该 callback/注册，不复制候选合同或创建相似 schema。

以下每个 callback 都为 `(scope: AllriceMcpScope, input: z.input<typeof InputSchema>, signal: AbortSignal) => Promise<CallToolResult>`；公开 alias 是其 `NonNullable<AllriceMcpServices['method']>`。只有真实 owner callback 绑定且模块/代际现权允许时才 list/call；没有绑定时隐藏并沿 DEPENDENCY_UNAVAILABLE 拒绝，不能落入 deliverableCreate。

| raw wire / method / public alias                                                        | InputSchema                       | module               |
| --------------------------------------------------------------------------------------- | --------------------------------- | -------------------- |
| reference_search / referenceSearch / AllriceMcpReferenceSearch                          | ReferenceSearchInputSchema        | enterprise-materials |
| reference_read_image / referenceReadImage / AllriceMcpReferenceReadImage                | ReferenceReadImageInputSchema     | enterprise-materials |
| reference_archive_list / referenceArchiveList / AllriceMcpReferenceArchiveList          | ReferenceArchiveListInputSchema   | enterprise-materials |
| reference_archive_read / referenceArchiveRead / AllriceMcpReferenceArchiveRead          | ReferenceArchiveReadInputSchema   | enterprise-materials |
| deliverable_document_read / deliverableDocumentRead / AllriceMcpDeliverableDocumentRead | WorkspaceDocumentReadArgsSchema   | deliverables         |
| memory_remember / memoryRemember / AllriceMcpMemoryRemember                             | RememberPersonalMemoryInputSchema | employee-memory      |

五个读取注册为只读提示；remember 不标只读或幂等。memory wire JSON 直接复用既有 workspace.memory.remember 完整 schema，运行时仍用 RememberPersonalMemoryInputSchema：strict 内容-only summary/details/memoryClass，details 省略默认 null、memoryClass 默认 work_note，保旧 Unicode/长度约束与归一规则。不接受 guest source/身份/worker/lease/approved。

memoryRemember 只返回原生 CallToolResult；真实候选事务、真人消息/steering 来源及 operation receipt 归 MET-283。成功仅投影真实候选回执且 requiresConfirmation=true，不能生成 active、伪造 source/native call 或补 3.x Run。普通业务旧错误沿 owner 的具名 isError 投影；本服务不新增任意 thrown error 透传或业务 result schema。

CallToolResultSchema 保原生 text/image/resource/structuredContent，不替业务 owner 做 allowlist。图片须有真实获权 bytes，attachment 元数据不是模型已读；搜索结果、图/归档 receipt 与文档 PDF/Office 薄投影仍待 MET-281 交付。host StorageObject.key、路径、凭据及 series/version 内部对象不得直接作为 guest 结果。没有绑定的业务能力不以协议 fixture 冒充。

已验证的 thrown ApiError/ReferenceSelectionError 现在与普通返回一起经过原 post-current 复核，未失权时原 payload 不变。selection IDs 仅允许 reference_read 及新增三项 exact-pin 图/归档工具的输入 revisionId；搜索不接受该错误披露。remember 后失权提示候选可能已提交，沿原 call 对账，不暗示回滚；旧 create 提示不变。

新增 callback 仍共用原 operation/AbortSignal、whenIdle 和 revoke/close 的真实 Promise join，绝不取消先返回并遗留事务。当前只有接口/注册 6/7，真实 271/273 身份资格、4.0 载体与 281/283 业务尚待绑定；不表示全部业务 ready。新增 SDK 协议回归及原完整文件须由 root 在固定头执行；源码或静态检查不算运行通过。

## 原生对照与 SaaS 边界

锁定 `@deepseek-ai/dsh-mcp-client@0.2.1-rc.2` 的 README、`lib/index.js` 的 `syncTools`/`createMcpToolDefinition`：DSH 负责发现、`mcp__<serverName>__<rawName>` 命名、工具生命周期、原生取消及 CallToolResult 投影。原名 `reference_read` 等只用于 MCP wire；配置名 `allrice` 由可信 DSH 装配决定，不从 remote serverInfo 或工具名反解身份。发现失败可留下旧工具，因此执行仍查现权。

本服务用已锁定的 `@modelcontextprotocol/sdk@1.30.0` `Server` advanced API，直接复用原有完整 JSON Schema；SDK 负责 initialize、tools/list、tools/call、list_changed 和 request cancellation。没有 XML、另一个 MCP client、万能工具 envelope 或 Agent 状态机。AllRice 自补限已批门卫（当前本人/企业/实例与模块资格、受管路由、代际、原生 call 关联）、既有存储和真实业务 receipt 单向投影。没有新表、模型/额度/TTL/并发规则。

## 五面

| 面               | M1 实际边界                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 后端/私有数据    | `allrice-server.ts` 与 owner 的三个公开薄出口；复用原资料、记忆、成果 carrier，不拥有其他模块全表；新增数据为 none。                                              |
| MCP              | 一个受管连接一个 SDK server；identity_read、reference_read、memory_read、deliverable_create；只公布已绑定 service 且当前模块有资格的工具。                        |
| 员工 UI          | none：本卡没有 UI 变更；完整 rev2 业务面仍为 MET-282/284，不取消该需求。                                                                                          |
| 后台 UI          | none：本卡不提供管理员管理/写入；完整管理仍由 MET-281/283/288 等交付。                                                                                            |
| 企业/员工/资源权 | host.current 每次重新取得现权、配置 revision 与 call；未装配 builtin 许可或 employee binding 不默认启用。真实 owner 仍校资源级别、精确版本/字节及现存 lease/CAS。 |

身份工具只输出 personId/organizationId/workspaceId/employeeInstanceId 的展示投影，不能授权。登录 RequestContext.sessionId 与 AllRice thread、DSH native session 不混用。host binding 固定企业、本人、workspace、员工实例、thread、DSH instance/profile/session、executionGeneration；guest 无权通过 arguments/header 选择其中任何一项。host.current 的 requestId 仅为不可信关联选择器，gateway 必须从自己受管映射解析 nativeCallRef。调用前后须保持同一 call/config revision；变化时不披露旧结果。

## 公开符号 allowlist 与既有合同映射

这些是已批准三 Port 的 **M1 子集与 legacy 迁移适配**，不是整个 proposed Port 已完成。worker 只从 `@allrice/database` 导入以下符号；原有 barrel 的其他导出没有因此成为跨模块许可。

| 允许符号/方法                                                                 | input/result/error 与实际 owner 原语                                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LegacyMcpExecution`                                                          | host-only 真 3.x ExecutionContext、session 与精确 worker/job/lease/attempt；schema parse 不认证，实际原语查持久权威。不能标成 4.0。                                                                                           |
| `createLegacyEnterpriseMaterialsMcpPort().readExact`                          | ReferenceReadInputSchema → executeEmployeeReferenceTool 的原 modelContent（实际正文、精确 source/revision/manifest digest/file checksum、committed citation ID）。不新造 receipt；完整 ReferenceRead 仍在 owner 真实 ledger。 |
| `createLegacyEmployeeMemoryMcpPort().readOrdinal`                             | MemoryOrdinalInputSchema → readRunMemoryOrdinal 的原 renderMemoryDetailV2 文本。issued pin、revision/pairDigest、active/current scope、真实 UTF-8 budget 均由原服务核验；MCP 不添加猜测的结构化 pin/hash。                    |
| `PreparedMcpDeliverable`、`createLegacyDeliverablesMcpPort().publishPrepared` | host-only 真实生成 bytes、既有 source/Office receipt → publishWorkbenchArtifact 的真实 immutable object/series/version/receipt。返回 persisted normalized object.checksum，不把输入 hash 当落库 hash；不降为 user-upload。    |

公开 schema 全沿 `@allrice/contracts` ApiVersion=v1、ContractVersion=1、CompatibilityPolicy rolling [1]；业务记忆为既有 V2 schema，原生 DSH 为当前单代。ReferenceReadSchema 强制 Run/generation/job/worker，RunMemoryContextV2StateSchema 强制 issued pins/预算，WorkbenchArtifact publisher 强制当前 Run/call；没有为 4.0 伪造这些字段。真实源码基线 `ec13399e7abcff68a6fae419c46a5c61a64f214e`；新增符号的固定 SHA/tree 由任务最终回执绑定。

`createLegacyAllriceMcpServices` 明确声明 3.x，并校验 host person/org/workspace/employee/thread/native instance/profile/session/call 与实际 gateway execution 关联一致。4.0 server 不发布或调用 3.x adapter。默认 inline provider 仅绑定已有 markdown/text/html/json 生成路径；Office/python/转换和 changeset provider 未接时返回既有 DEPENDENCY_UNAVAILABLE，不伪造 Office 质量。模型 input 沿现 workspace.export.create JSON Schema；prepared bytes、host quality stamp、worker 和外发批准不入 guest schema。

成果 owner 从本次 host authority 强制捕获 `expectedExecution` 的 worker/job/leaseToken/attempt，prepared 类型不能携带或覆盖它。既有 publisher 的三个事务检查点在首次 storage.put 前及提交前校验精确租约，保持原 `FOR SHARE` 锁；锁前换租约会拒绝，锁后轮换被串行化，真实时间到期仍会回滚新版本。该参数仅供受管接缝使用，原调用不传时语义不变。既有同 Run+call+requestDigest receipt 分支仍先查当前资源权限、恢复已提交版本，允许原执行取消后对账；异 digest 拒绝，不把恢复权限当成新发布权限。

业务错误保留现有 code/message/retryable，通过原生 isError 返回：DataAccessError 映射既有 ApiErrorSchema 对应码；MemoryContextError、ReferenceRuntimeError、EmployeeRuntimeContentError、ArtifactReviewError 沿现有具名工具错误投影；ReferenceSelectionUnavailableError 沿 ReferenceSelectionErrorSchema，ID 限本次输入。已确认 publication rollback 才映射 TOOL_PUBLICATION_ROLLED_BACK/retryable；未知 SQL/transport 错误不暴露 stack/SQL，也不伪造失败效果或自动重试。

## 取消、关闭、恢复与占位

native request.signal 与连接 shutdown signal 合并传给实际业务服务。`whenIdle()` 只等待；`close()` 停止准入、abort，再等待所有实际操作收敛后关闭 SDK。现 memory/publisher 的不可中断事务不会被 Promise.race 丢在后台，取消后不再返新正文；已提交预算/版本仍成立，取消与丢 ACK 不代表回滚。无自动重连重发/new-key 重试；同 call 对账沿现 owner 账本。

owner 配置/撤权变更调用原生 notifyCatalogChanged；即使客户端刷新失败留旧目录，call 仍现权拒绝。没有新增持续业务 stream；资料分页沿既有 offset/schema，不能把 receipt 当已读全文或模型实际使用。恢复集合仍是冻结边界合同第 7 节：对象 bytes/checksum、资料/记忆/成果版本及实际 receipt、模块配置、原生日志与可信调用关联同点恢复；本卡没有新增恢复或发布流程。

保留未来 **approval** 与 **bridge** 的独立 MCP namespace/owner 接入位置，本卡零工具、零默认授权。MCP 参数中的 approved 或 DSH guest 内批准不授予外发权；将来外发仍由 VM 外可信 origin 冻结目标/正文/附件并经既有 ApprovalExecutionPort/EgressPort。Bridge 仍沿既有 gateway catalog/invoke/cancel/receipt/list_changed 与设备 journal/outbox，本卡不实现设备端或直连 guest。

## 验证与剩余绑定

新增单文件 SDK 协议测试覆盖缺失 carrier、3.x/4.0 拒绝、身份/路由与 call/config 切换、guest 权限字段、旧目录撤权、原生 cancel/close/drain、原生错误。新增 DB suite 使用明确 3.x gateway fixture，走 SDK → 新公开 owner 适配 → 实际 PG 服务与 storage：资料真实正文/pin/receipt、私有/撤权/改 hash、记忆 issued ordinal/预算/失效 lease、成果 immutable 字节/hash/版本/幂等冲突、实际存储写取消后收敛。没有调用模型、VM 或共享 Dev。

成果租约回归还覆盖同 worker 的 token 轮换、错误 attempt、空/无效 token、worker/job 与 context 不符、真实生成等待期间换租约，以及持锁 storage IO 等待时真实 lease 到期后无新增版本/publication audit 且私有 blob 清理。已提交 receipt 在换租约并取消后可恢复，异内容仍冲突、新 call 仍拒绝，撤销当前成员资格后恢复也拒绝。这些用例由最终 SHA 的根线门禁执行，源码断言本身不是通过证据。

DB suite 由 ALLRICE_RUN_DB_INTEGRATION 开启，CI 文件责任登记为 db；现有 fixture 初始化/每项 timeout 保持 120000ms，清理 30000ms。直接影响既有回归：native-client.test.ts、employees/reference-tools.integration.test.ts、run-memory-index.integration.test.ts、artifact-publication-concurrency.integration.test.ts；未改下载/版本读取链。重门禁和独审由 root 绑定最终 SHA 执行，不能把 skip/fixture 当生产通过。

仍待 271 受管 MCP 连接到可信当前身份、native call/root/撤权的公开映射；273 currentScope/currentModuleQualification/currentContentAuthority 与 builtin release/binding；281/283 所属业务的 4.0 receipt/memory issued pins+budget/publisher carrier。代际类型回交不关闭这些生产映射缺口。274 历史快照不是这些业务账本 owner，本卡不扩其表。旧文档的 gateway executionBinding/nativeCallContext 是 proposed 名称，不是本片已实现的 model gateway 导出。四段 instructions、逐实际父/子 request token/schema/Skill 证据属于 MET-273/285 装配，本卡没有实际模型请求，不能声称已验 ≤2048 token。

MET-225 拟登记：VM 外 AllRice 业务 MCP server，DSH 保持原生发现/命名/调用/取消/result；AllRice 仅 host 现权与 owner 业务事实，4.0 carrier 未绑拒绝。由发布主会话同步。新功能错误可由 native MCP isError/协议失败与现有 owner receipt 对账发现；没有安装新巡检，根线同步 MET-222 待联合验收项。
