# 4.0 外发审批网关（MET-270）

本模块是边界合同 v1 第 4、6、9 节的宿主门卫和业务效果账本。DSH 继续拥有原生审批、工具调用和 Agent 生命周期；guest 内批准不构成 AllRice 对外发送授权。沿用原生 MCP `tools/list`、`tools/call` 和 `CallToolResult`，不修改 DSH、不复制 Agent 状态。phase4 `host-delivery` 的内存样机仅作对照，正式幂等和未知效果必须持久化。

本提交提供独立模块与必填的宿主端口，尚未装入真实 VM/BFF，也没有启用任何真实发送目的地。正式页面要先由用户确认预览，再接这里的浏览器接口。下列接线前提不能用测试夹具替代。

## 五面与接口归属

| 面             | 本模块交付及接线责任                                                                                                                                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 后端与私有数据 | `@allrice/approval-gateway` 服务、PostgreSQL store；只拥有 `allrice_outbound_approvals`。外部模块不得直接读写表。冻结对象字节与外发效果保存在同一行，避免跨表事务遗漏                                                                                                         |
| MCP            | `createApprovalMcpServer`：`outbound.stage`、`outbound.execute`、`outbound.status`；不暴露真人批准/撤销/对账工具。MET-269/273 的受管连接负责认证、绑定真实 Run/native call、连接 transport；初始 enabled 必填，宿主 setEnabled 经 SDK handles 发 list_changed，旧调用仍验现权 |
| 右栏/主区      | `createApprovalBrowserHandler` 只供 VM 外可信 BFF；展示宿主冻结的操作说明、完整目标、正文、附件名/字节摘要及实际回执。产品页面待设计确认；不得在 guest 页面嵌入或渲染不可信 HTML                                                                                              |
| 后台           | 不新增管理员代批权。原始业务效果由模块读取；未知结果由本人在可信入口调用 reconcile，经目的地公开回执接口核对                                                                                                                                                                  |
| 开关与权限     | 装配方只注册已批准的 destination/resource owner，关闭时不注册 MCP 和 BFF 路由；当前本人/企业/员工/资源权限由必填 authority 与 owner 接口检查，不能依赖 UI 隐藏                                                                                                                |

公开入口见包 `src/index.ts`，具名输入契约见 `src/contract.ts`。`ApprovalBinding` 只能来自已认证宿主，包含 VM/租约 epoch、企业/本人、工作区、员工 release、线程、真实执行关联和原生根/子会话映射。MCP request ID 只是关联值，不是身份。新的调用可在同一已验证根会话重试同一业务键；原始 Run/native call 仍保留在记录中。VM epoch、员工 release、根会话或执行代际变化不能沿用批准。

## 装配必须实现的端口

- `ApprovalAuthority.assertCall/assertUser`：从实际身份、当前员工配置/开关和受管会话确认准入。`admit` 必须与撤权串行化，覆盖领取到真实发送的整段操作；撤权要 abort 并 drain 在途调用；callback 显式接收 owner 控制的 admissionSignal，与调用方 signal 合并后传给发送方。不能接空实现，也不能凭 guest JSON 构造上下文。
- `ApprovalResourceOwner.snapshot/assertCurrent`：通过资料/成果等所属模块公开 API 获取不可变精确版本与真实字节，每次查看/批准/执行/下载再查现权；不能把 guest 路径当宿主文件权限。`maxBytes` 是可接受剩余量，owner 应在读取中实施限制。
- `ApprovalDestination.resolve/assertCurrent/dispatch/lookup`：宿主注册的固定能力，不能让模型传任意 URL。resolve 得到实际目标和可读标识；target.id 必须是包含实际发送账户与目标的不可变宿主路由引用，assertCurrent 在账号/路由变动时拒绝旧引用；dispatch 使用 `requestId` 为接收端业务幂等键，回执必须绑定冻结 digest；lookup 查询同一个键，不能补发。dispatch/lookup 显式接收 host-only binding，按真实本人选择宿主凭据；不依赖 guest 目标文本决定账号。发送权限/凭据留在宿主，错误回执不输出内部异常。
- 请求/正文/附件大小和数量从装配方既有业务限制配置传入；本模块无默认 TTL、自动批准、自动补发或隐式外发地址。

## 数据、迁移与恢复

模块版本迁移在 `packages/approval-gateway/migrations/0001_outbound_approvals.sql`。store 接收所属模块的 `Sql` 句柄，**不会自动建表**。批次部署方须将这个模块迁移接入受控部署清单、授权数据库连接与恢复集合后再挂服务；本 PR 不修改或执行共享 Dev 迁移。不冒填旧 3.x runtime approval 所要求的 policySnapshot/Run/execution 字段。

冻结 digest 对规范排序 JSON（身份作用域 + 实际目标 + 正文 + 精确附件字节/摘要）计算，避免 JSONB 键顺序导致重启后误判。业务幂等键受本人/企业/工作区/员工/适配器隔离；重复键若字节改变直接冲突。store 的行锁一次性提交执行意图，之后任何重复调用均不再次 dispatch。接收端已提交但 ACK 未返回、进程崩溃或回执落库失败，一律保持 unknown；查不到回执不会伪造失败或清掉意图。首个受控失败分类（取消、发送错误、回执完整性、回执落库）和时间写入同一账本，后续故障/对账不覆盖；不保存外部异常原文或 SQL 参数。诊断写入也失败时返回 UNAVAILABLE，持久意图仍禁止补发。

冻结字节是模块私有数据，不进入 MCP 结果或日志；可信下载每次验权，强制附件下载、nosniff 和 sandbox。恢复必须同时保留批准、不可变字节、执行意图、接收端幂等键和回执；**不得把账本回滚到外部发送之前再允许重发**。撤销只在执行意图前有效，不能承诺撤回已外发内容。生产存储加密/备份沿平台保管策略。

## 发现问题、合同测试与未完成项

- MCP 协议测试使用官方 SDK Client/InMemoryTransport，验证模型无法调用真人决策接口；它不是实际 DSH/VM 端到端验收。
- 服务测试覆盖现权、跨人/VM epoch/摘要伪造、冻结附件、并发防重、拒绝/撤销、在途 abort、源文件变化。
- `postgres.integration.test.ts` 使用独立 schema；真实子进程在合成接收端 fsync 后、ACK 前被杀，重建网关后只 lookup 回执、不重发。该文件声明为 CI 普通 DB 测试，不归 manual。
- BFF handler 测试检查 Origin、独立 guest hostname、CSRF、实际服务端身份和只读附件；真正浏览器点击、跨 origin cookie、VM root 攻击和正式会话接线仍须联合验证。
- 业务巡检应报告长期 unknown、owner 端口不可用、回执 digest 不匹配，不能将 tool success 或 Run succeeded 当外发成功；现有展示只回真实 `effect/receipt`。正式告警和后台装配随接线落地，未启用时不得声称已受监控。

真实 VM 验证排在模型线 MET-266 之后；产品合并/迁移/部署等待整批批准。关闭回滚只摘除入口和新请求，保留账本与未知效果供对账，不删表、不重发。
