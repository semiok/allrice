# 普通个人记忆管理 v2

本包依赖 PR1 的 pair 存储和迁移，提供完整后端管理合同；匹配的 MET-251 前端、后续候选生产及新 Run 索引/编号读取仍须组合验证。本包不具备独立部署条件，不把旧 UI 的类型可编译视为可用，不恢复 C/#788 或 checkpoint 维护任务。

## 本人入口

| 请求                                                 | 合同                                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| GET `/api/v1/memories/manage?workspaceId&instanceId` | schemaVersion=2；全部 active/pending 最小行及同读 counts；不分页            |
| GET `/api/v1/memories/{id}?workspaceId&instanceId`   | 当前完整 pair；自身删除/过期为 404                                          |
| POST `/api/v1/memories`                              | workspaceId、instanceId、summary、details?、idempotencyKey；本人直接 active |
| PATCH `/api/v1/memories/{id}?workspaceId`            | 完整 pair、reason 和 Mutation；pending 保存即确认                           |
| POST `/api/v1/memories/{id}/promote?workspaceId`     | Mutation；不改 pair 的本人确认                                              |
| DELETE `/api/v1/memories/{id}?workspaceId`           | Mutation；204 无正文，随后刷新列表                                          |

Mutation 必含 instanceId、expectedRevision、pairDigest、idempotencyKey。PATCH 必须显式 details：字符串保留完整说明，NULL 清除，遗漏为 400。summary/details 沿 PR1 的 Unicode code-point 40/2000 合同；前端原样回传服务端 pairDigest。

Record 字段只有 id、summary、details、hasDetails、state、revision、pairDigest、capturedAt、updatedAt；列表行省略 details。capturedAt 来自真实 captured_at，编辑/确认不重置；active 按 updatedAt DESC，pending 按 capturedAt DESC，同时间按 UUID DESC。

counts 为 active、pending、maxActive=100。新增、pending 保存/确认先取得原有同 scope 短串行锁，再按原 source→receipt→row 顺序处理，只有增加 active 才检查名额；满额 active 编辑/当前合法回执不增额。后台只保存 candidate，不争夺前台名额锁。写后 counts 是成功事务的结果快照，回执重放返回原快照，刷新列表可取得后续计数。

本人入口每次读写重新核当前 tenant/workspace/owner/instance、成员和员工可用性；同源浏览器写不能由模型或管理员冒充。管理员沿既有独立只读目标范围核组织/workspace/instance/owner/membership，不借用本人 context 或新增员工停用/归档拒绝。管理员 GET 只读使用既有 `/api/v1/admin/organizations/{organizationId}/employee-memories?ownerId&instanceId`；UUID 详情在该路径下 `/{id}`，query 仍为 ownerId、instanceId。每次成功列表/详情用真实管理员 actor 写独立 admin_read，审计只含 scope/目标/数量/版本，不记正文。

## 冲突与旧合同

统一 HTTP409、error.code=CONFLICT、retryable=false；error.details 为严格 employee_memory 联合：

| reason               | 附加字段                          | 处理                                                     |
| -------------------- | --------------------------------- | -------------------------------------------------------- |
| cas_conflict         | 无                                | 保留草稿，重新读取当前完整 pair，由本人核对              |
| idempotency_conflict | 无                                | 同 key 内容/动作/目标改变或回执已过时；不自动换 key 覆盖 |
| memory_limit_reached | counts={active:100,maxActive:100} | 已鉴权 scope 的事务串行点真实快照；拒绝增加名额          |
| contract_changed     | requiredSchemaVersion=2           | 重读 v2；不提交摘要作为旧完整正文，不清说明求兼容        |

其他 API 不传 details 时保留原信封形状。旧 422 memory_capacity 不是 v2 名额合同，不能解析 message 猜原因。

旧单 content 创建保留 PR1 的显式机械转换。真实 null-pair legacy PATCH 可作无损适配；已 paired 的旧 PATCH 即使拿当前 revision/contentDigest 也先拒绝且零写入。expired legacy 在实际 UPDATE 用数据库 clock_timestamp() 拒绝；不能显式传 NULL 复活。

pin endpoint 已退役，继续鉴权及目标门卫后返回 contract_changed，不改历史 pin metadata/审计/修订。manage 不接受 state/after/search/filter/pin/preview；不存在 archived/expired 管理分组、nextCursor、budget。旧字段 schemas 只供尚待匹配的旧消费者编译，不是隐藏版本开关。

旧通用 GET `/memories`、按 source/run 的读取、revisions 和已冻结 v1 Run 的文档/来源/预算仍按原合同独立保留；管理 Row 不把 source IDs、原聊天、tool 输出或私有 profile 带入新接口。管理 HTTP 不向模型授予浏览器身份或预算旁路。新模型注入/ordinal 工具由后续 PR 单独实现。

## 候选和来源边界

PR4 的真实普通 mutation 核心供后续 PR3 生产入口复用。pending→active 对已知 message/checkpoint 复核同 scope 未撤回 session/原身份，对 file 复核确切存储对象和现有读取权限；active 编辑不按另一记忆的删除或原来源重新审判。没有 L0/cutoff 或删除摘要过滤。

普通 tool/connector 保留既有本人 scope、记录 CAS、本人确认语义；其 opaque sourceId 没有资源种类，当前无真实生产 caller，不能据此宣称具备外部撤回证明或授予外部资源权限。后续 PR3 不新增该类生产，也不把它与 C review/receipt 混同。C/#788 没有被本包接入、验证或恢复。

旧 writer 的 source+contentDigest 幂等键和已 archive 同源的新建拒绝未在 PR4 改动；PR3 按软删除决定另分旧操作重放与新 pending 提议。删除 A 不隐藏/禁改已存在的同源 B，也不使 A 自身重新可见。

## 回退与验证边界

没有新增 PG 表、状态或迁移，没有真实 DB 操作。本包仅复用存储、门卫和单向审计/回执，不涉及 DSH 原生 Agent 能力或新租约。

保留 PR1 恢复 runbook：事务失败全部回滚；已提交数据/新用户和候选写入不能丢失；补偿必须追加修订并以当前 pair/revision CAS，不原地改历史 revision，不提供丢数据逆迁移。旧/新冻结 Run 不互相改写或重置预算。

回退 HTTP 消费者前必须验证其认识已写 pair、回执和统一错误信封；旧 UI 不是可直接回滚的管理消费者。保留已提交数据并向前修复，不能靠清空 details、删除新回执或恢复旧库求可用。

验证由发布主会话安排同头独审、M5、四门 CI 与 matching MET-251/完整消费者组合。本文不证明实际恢复、真实 Run、Dev 迁移或上线验收成功。
