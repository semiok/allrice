# MET-272：M1 原生 MCP 可联调接缝

当前交付是原生 SDK server、host 现权/代际/调用绑定和三模块 M1 公开子集。4.0 的 execution/receipt、issued memory pin/预算及 publisher carrier 尚待所属 owner 公开绑定；这不表示模块已迁入或 4.0 生产业务全通。没有启动入口、默认配置或企业/员工开关变更。

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

业务错误保留现有 code/message/retryable，通过原生 isError 返回：DataAccessError 映射既有 ApiErrorSchema 对应码；MemoryContextError、ReferenceRuntimeError、EmployeeRuntimeContentError、ArtifactReviewError 沿现有具名工具错误投影；ReferenceSelectionUnavailableError 沿 ReferenceSelectionErrorSchema，ID 限本次输入。已确认 publication rollback 才映射 TOOL_PUBLICATION_ROLLED_BACK/retryable；未知 SQL/transport 错误不暴露 stack/SQL，也不伪造失败效果或自动重试。

## 取消、关闭、恢复与占位

native request.signal 与连接 shutdown signal 合并传给实际业务服务。`whenIdle()` 只等待；`close()` 停止准入、abort，再等待所有实际操作收敛后关闭 SDK。现 memory/publisher 的不可中断事务不会被 Promise.race 丢在后台，取消后不再返新正文；已提交预算/版本仍成立，取消与丢 ACK 不代表回滚。无自动重连重发/new-key 重试；同 call 对账沿现 owner 账本。

owner 配置/撤权变更调用原生 notifyCatalogChanged；即使客户端刷新失败留旧目录，call 仍现权拒绝。没有新增持续业务 stream；资料分页沿既有 offset/schema，不能把 receipt 当已读全文或模型实际使用。恢复集合仍是冻结边界合同第 7 节：对象 bytes/checksum、资料/记忆/成果版本及实际 receipt、模块配置、原生日志与可信调用关联同点恢复；本卡没有新增恢复或发布流程。

保留未来 **approval** 与 **bridge** 的独立 MCP namespace/owner 接入位置，本卡零工具、零默认授权。MCP 参数中的 approved 或 DSH guest 内批准不授予外发权；将来外发仍由 VM 外可信 origin 冻结目标/正文/附件并经既有 ApprovalExecutionPort/EgressPort。Bridge 仍沿既有 gateway catalog/invoke/cancel/receipt/list_changed 与设备 journal/outbox，本卡不实现设备端或直连 guest。

## 验证与剩余绑定

新增单文件 SDK 协议测试覆盖缺失 carrier、3.x/4.0 拒绝、身份/路由与 call/config 切换、guest 权限字段、旧目录撤权、原生 cancel/close/drain、原生错误。新增 DB suite 使用明确 3.x gateway fixture，走 SDK → 新公开 owner 适配 → 实际 PG 服务与 storage：资料真实正文/pin/receipt、私有/撤权/改 hash、记忆 issued ordinal/预算/失效 lease、成果 immutable 字节/hash/版本/幂等冲突、实际存储写取消后收敛。没有调用模型、VM 或共享 Dev。

DB suite 由 ALLRICE_RUN_DB_INTEGRATION 开启，CI 文件责任登记为 db；现有 fixture 初始化/每项 timeout 保持 120000ms，清理 30000ms。直接影响既有回归：native-client.test.ts、employees/reference-tools.integration.test.ts、run-memory-index.integration.test.ts、artifact-publication-concurrency.integration.test.ts；未改下载/版本读取链。重门禁和独审由 root 绑定最终 SHA 执行，不能把 skip/fixture 当生产通过。

仍待 MET-268 gateway executionBinding/nativeCallContext、MET-273 currentScope/currentModuleQualification/currentContentAuthority 与 builtin release/binding、MET-274/业务 owner 的 4.0 receipt/memory issued pins+budget/publisher carrier 精确公开出口；不在本卡扩 MET-274 账本。四段 instructions、逐实际父/子 request token/schema/Skill 证据属于 MET-273/285 装配，本卡没有实际模型请求，不能声称已验 ≤2048 token。

MET-225 拟登记：VM 外 AllRice 业务 MCP server，DSH 保持原生发现/命名/调用/取消/result；AllRice 仅 host 现权与 owner 业务事实，4.0 carrier 未绑拒绝。由发布主会话同步。新功能错误可由 native MCP isError/协议失败与现有 owner receipt 对账发现；没有安装新巡检，根线同步 MET-222 待联合验收项。
