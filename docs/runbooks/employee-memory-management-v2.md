# 普通个人记忆管理 v2

当前个人记忆唯一管理合同为 V2 summary/details、本人确认和编号读取。旧经验、旧全文 editor、搜索及外部 lifecycleState/durable/expiresAt/content 参数已退出；本文描述接口，不证明本批门禁或部署完成。

## 本人入口

| 请求                                                 | 合同                                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| GET `/api/v1/memories/manage?workspaceId&instanceId` | schemaVersion=2；全部 active/pending 最小行及同读 counts；不分页            |
| GET `/api/v1/memories/{id}?workspaceId&instanceId`   | 当前完整 pair；自身删除或失去权限为 404                                     |
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

通用 GET `/memories` 只返回 V2 行和核对范围所需的 owner/workspace/instance，不返回旧全文或有效期。按 source/run 的读取保留本 Run 原真人消息与 adopted steering 来源过滤；revisions 继续供当前冻结修订与审计使用。管理 Row 不向模型授予浏览器身份或绕过 Run 预算。

manage 不接受 state/after/search/filter/pin/preview，不提供 archived/expired 管理分组、nextCursor 或旧 capacity_preview。已退役 pin 入口与全文兼容参数不再可调用。

## 候选和来源边界

PR4 的真实普通 mutation 核心供后续 PR3 生产入口复用。pending→active 继续复核当前 scope、未撤回来源及原身份；active 编辑不按另一记忆的删除或原来源重新审判。没有 L0/cutoff 或删除摘要过滤。

当前模型候选不新增文件、tool/connector 或外部资料生产通道，不把素材采集视为本人事实、普通 pending 或确认。独立 A1 素材存储与配置继续隔离。

## 回退与验证边界

管理接口复用原有 PG 表和状态。本包仅复用存储、门卫和单向审计/回执，不涉及 DSH 原生 Agent 能力或新租约。

保留当前 pair 恢复 runbook：事务失败全部回滚；已提交数据/新用户和候选写入不能丢失；补偿必须追加修订并以当前 pair/revision CAS，不原地改历史 revision，不提供丢数据逆迁移。当前冻结 Run 不改写或重置预算。

回退 HTTP 消费者前必须验证其认识已写 pair、回执和统一错误信封；旧 UI 不是可直接回滚的管理消费者。保留已提交数据并向前修复，不能靠清空 details、删除新回执或恢复旧库求可用。

验证由发布主会话安排同头独审、M5、四门 CI 与 matching MET-251/完整消费者组合。本文不证明实际恢复、真实 Run、Dev 迁移或上线验收成功。
