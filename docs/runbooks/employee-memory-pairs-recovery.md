# 个人记忆 pair 存储迁移与恢复（0235，draft）

离完整记忆侧栏还差：v2 HTTP/管理消费端、冻结 Run 的 v2 索引/详情与最终预算、候选管线及其独立验收。PR1 仅提供字段、可调用存储函数和旧写保护，**不可单独部署**；本文不授权 Dev 迁移、恢复、停止 Run 或数据处置。

## 合同与部署前记录

- 唯一迁移名为 `0235_employee_memory_pairs.sql`；保留两个既有 `0234_*` 文件名。四个 nullable 列是业务内容，不是生命周期状态；无新表。
- 普通个人 pair 使用 Unicode code point 40/2000。详情仅在全空白时规范为 NULL，非空详情逐字保留；摘要仅将行分隔符机械换为空格并处理首尾空白。NUL、孤立 surrogate 按 PostgreSQL/JSON 存储能力拒绝。
- `pairDigest` 复用现有 canonical JSON SHA-256，输入为 `{version:2,summary,details}`。当前行、递增 revision、原幂等回执表和审计在同一事务中提交。
- 迁移不改旧 `content`、旧 revision、raw review、pin metadata、归档身份及原 `updated_at`/`captured_at`。短正文完整作为 summary；长正文前 40 code point 作为 summary，**完整原文**作为 details。普通未归档行的未来 expiry 清 NULL；已过期行先拒绝，不复活。
- 旧完整 content 创建/一次 legacy 修改保留原 content 输入语义，且不扩旧调用方的校验、权限和确认权。新写同时保存 pair；以后新的旧单字段修改返回 409 `employee_memory_contract_changed`，包括 details=NULL、当前 revision/contentDigest 均匹配的情况。合法同请求的当前回执先按原合同重放。
- 显式 v2 创建/active 编辑使用 summary 作为 content 兼容投影。存储函数未接 HTTP；v2 编辑要求显式 details/string 或 NULL，未实现 pending CRUD。既有 pending promote 合同保留。消费者/全文预算尚未切换，不能借 content 投影把 PR1 当作上线组合。

发布负责人将来申请迁移前，使用正式停写/快照工具保存数据库、Run/DSH 状态目录、配置和执行包，记录应用 SHA、完整迁移名集合、时间及存储高水位。只读状态命令为 `~/allrice-dev/bin/deploy-dev --status`。实际部署/恢复必须另外取得对应授权。

## 预检与原始失败

迁移在同一 PG 事务中加字段、持有 memory/revision 关系锁、输出 `employee_memory_pair_preflight` 聚合，合格后才开始回填。聚合覆盖普通行数、无有效归属、空白/无效摘要、超过 2000、过期/未来期限、scope 生效数超过 100、可被旧读取但不在个人管理集合的 legacy review、当前修订缺失/原文不符，以及分类/状态/sourceType/lineage 计数。

该 SQL 的 L1 只证明原始 message identity 精确落在同 scope；它不授予当前真人权限。checkpoint、user+NULL、不完整 occurrence、file/connector 均不伪造成 message lineage。候选采集/确认的授权与来源政策不由本迁移决定。

任一异常返回 SQLSTATE `23514`、`employee_memory_pair_preflight_failed` 和聚合 JSON detail，整笔事务回滚。保留第一次日志；不截断、猜归属、删行、保留前 100 条、自动归档或重跑求绿。无原文、用户 ID、来源正文进入 notice。修正或业务处置由主线按授权决定。

成功 notice `employee_memory_pair_backfill` 含 migrated 数和前后集合 digest。digest 先逐行哈希全部列，再按 ID 有序聚合固定长度哈希，避免聚合 raw 全文。每条迁移审计使用空 actor、`memory.migrate_pair`/`system_backfill`，metadata 保存迁移名、原/新 revision、原 contentDigest 和 pairDigest；新 revision 的 reason 明示 system 迁移及原 revision。旧表要求 changed_by 非空，因此引用原 owner，不把该修订标为本人删除/确认。

## 恢复矩阵

| 状态                                       | 必须保留/验证                                                                       | 允许的恢复方向                                                                                                                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 迁移事务未提交而失败                       | 初始错误、数据库原字段/正文/修订/回执、Run 状态                                     | 事务自然回滚；不手工登记迁移成功。修复后另定精确候选与演练，不自动重试。                                                                                                                     |
| 已提交，证明没有任何新用户、候选、Run 写入 | 比较快照高水位、行/revision/回执集合、Run 及其原生日志/状态目录；不能只凭页面未开放 | 首选认识 0235 的前向修复。若确实要恢复全套快照，须另获恢复/数据处置授权，并按现有 [数据库手册](m1-database.md#恢复备份或迁移前快照) 一起恢复配套数据库、Run/DSH 状态、配置和执行包。         |
| 已有新建/编辑/确认/删除/候选/Run 写入      | 当前 pair、所有新旧 revision、回执、审计、归档、候选状态、冻结 pin 和已消耗预算     | 默认前向兼容修复，保留 0235 迁移认识范围及内容列。禁止逆迁移、删新行/新 revision、清 details、回退 revision、复活归档或把候选升为 active。                                                   |
| 某条机械回填确需修复                       | 迁移审计和原 revision、最新 pair/revision/归档/信任状态                             | 锁当前 scope/identity，在同一事务比较当前 revision **及 pairDigest**，追加带 system 修复原因及被修复 revision 引用的补偿修订、更新当前行/投影并留审计。CAS 不符则整笔拒绝；不改旧 revision。 |

已被本人编辑/确认/删除的记录不能被迁移前原文覆盖。若错误仅在表示上，依据最新合法 pair 修复；无法确定时停止受影响 scope 并上报。修复不得伪造本人删除审计、触发 cutoff、改变候选状态、回退回执或擅自取消 Run。没有丢新数据的逆迁移脚本。

兼容修复版本必须认识数据库中的全部迁移；旧 binary 不认识 0235 时，正式部署工具会拒绝回滚。将来采用的前向候选命令仍为 `~/allrice-dev/bin/deploy-dev --release-manager --ref <已批准的完整兼容提交>`，只能由发布负责人在获批窗口执行。旧单字段 UI 对 paired 记忆不能无损编辑，必须先配套消费者，不能先解除 409 门卫。

## 冻结 Run 与隔离验收

v1 已发放 pin 继续读取旧 revision 的原 content；不重绑 pin、改 snapshot 或重置已消耗预算。迁移追加当前 revision 不会替换旧 pin 引用。若将来已有 v2 冻结 Run，兼容修复必须保留其 pair revision、编号和预算解析，直至这些 Run 不再需要。PR1 没有创建 v2 Run 合同，不能构造假 v2 snapshot 冒充验收。

若已发放的某 revision 本身错误，仅补偿当前 revision 不能宣称修好了该 pin。记录精确 Run/修订，交主线按现有安全门卫、停任务授权和恢复规则决定；不自动重绑或取消。

本包隔离测试包含：七类异常及整笔回滚；旧 content/历史 revision/raw review/排序不变；迁移系统修订/审计；真实冻结 v1 pin 迁移前后读取与原预算；迁移后新建、编辑、删除、候选与过时 CAS 补偿拒绝。测试仍须由主线在精确提交上执行。新 v2 冻结 Run、最终消费者组合、真实快照恢复、Dev 迁移/部署均未验证，后续组合获批前不得标 ready。

异常通过预检错误、CAS/409、原审计及测试发现。当前没有独立常驻 pair 业务巡检；需要时由主线在 MET-222 记录，不能把缺失巡检写成已经就绪。
