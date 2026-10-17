# 私人经验采用（MET183 PR3b1 / PR3b2）

公司在现有后台经验策略中明确开启自动采用后，既有 tick 消费已经整理的固定草稿和验证结果。默认关闭；关闭后停止新增采用，已经采用的经验可由本人撤回。通用和定制 AI 员工使用同一机制，经验严格归属于公司、工作区、真人和具体 AI 员工实例。

## 首个受支持闭环

- 人数规则复用 PR3a 的名单专项验证：固定草稿、来源、独立测试、样例摘要必须一致。既有验证通过后不再调用模型。
- 报告表达偏好只接受明确反馈支持的有限形式；不从泛泛好评推断业务规则。明确个人设置和已发布要求优先。
- 完整规则及适用条件必须属于已支持类型。其他业务规则和截断来源仍待验证，不因关键词命中自动采用。
- PR3b2 支持名单专项验证与纯正文个人 Skill 联合验证；不扩大为任意 Skill、脚本、文件包或其他业务正确性证明。

## 个人 Skill 联合验证

来源必须包含原任务的成功原生加载回执，精确匹配个人 Skill 的归属、绑定、epoch、版本与校验和。测试冻结草稿实际引用来源的依赖，不将同一批次其他草稿的依赖混入。冲突版本不会被静默替换为最新版。

迁移 0182 允许独立测试的 v2 绑定，保留 v1 和不可变约束。个人 Skill 作为独立覆盖层传给现有 DSH；不改写已发布平台包或其校验和。测试没有普通聊天身份、读文件、命令或写入工具。授权检查绑定真实测试、Run、Job、Worker 租约及期限，在原生加载时再次检查。

只有同一测试、同一尝试、指定版本的原生 `skill` 成功回执，加上固定名单四个样例的独立数值检查，都通过才可采用。目录登记或模型声称加载不算证明。技能正文要求其他工具时，不因此获得这些工具，也不视为已覆盖。

完整规则识别允许有限的等价句式，按句子和分句核对原始名单、分别统计、明确状态及缺失信息时不推算的边界；不会把标点全部删除后拼出不存在的否定。识别器升级不改变 `attendance_groups/v1` 语义身份或独立样例摘要，已撤回的同类经验仍然优先。

迁移 0183 为旧的“尚无完整规则及技能联合覆盖”草稿追加一次版本化续验记录，绑定原验证计划摘要、原输出及草稿摘要与新测试。原草稿、原验证计划、历史失败不改写；已存在任何状态的测试、其他权限或资源拒绝均不重跑。当前来源、Skill、策略与预算仍须通过原有检查。预算不足暂缓，不消耗续验机会；测试与续验记录在同一事务创建。只有该草稿的覆盖不足采用记录被唤醒，已处理的其他草稿保留。

调度、领取、原生加载、完成、采用和后续读取均检查当前版本。新 Run 的冻结个人 Skill 必须包含证明中的精确版本；更新、停用、重新绑定或卸载使依赖旧身份的经验不可用，原证明和历史记录保留，不自动转移到新版本。某个 Skill 撤销不影响同批次不依赖它的经验。本人遗忘的墓碑仍优先，重复调度不能恢复。

## 持久化与运行接线

复用 `allrice_memories`、修订、经验来源、RAG 和原有调度。迁移 0181 增加不可变自动采用证明、批次采用计划以及 Run 的读取凭据/准备回执。自动采用明确记录平台策略授权，`reviewed_by` 为空，不伪装成人工审核。

每个 Run 在选择原生上下文前，按真实 Worker 租约、取消、期限及当前权限检查。自动召回最多 3 条、6000 字符；完整规则和适用条件一起注入，不截断边界。读取记录写入 Run，当前规则/来源变更时不再读取；同实例可跨会话，其他实例和账号不能共享。普通记忆召回、编辑、人工批准及公司分享入口均不能绕过此检查。

聊天遗忘使用持久化的当前用户原话识别直接命令，唯一匹配本人此实例经验后归档、删除召回索引并保存服务端回执。引文、否定、临时要求、歧义均不授权删除。取消、租约被替换或过期的 Worker 不能提交遗忘。归档墓碑保留，重复 tick 不复活经验。旧原生历史、压缩导入和排队快照仍检查读取凭据；原始任务及证据不改写。

页面展示采用、停用、撤回、版本和为任务提供经验的次数。提供次数是服务端准备记录，不声称模型一定遵守了经验或任务一定正确。

## 经验详情与历史（MET183 PR4）

员工详情的“经验积累”页签按需读取真实策略、调度和账本。配置频率与实际安排分开：未创建调度、关闭、暂停、暂无新增反馈各有状态；最近调度检查不代表已调用模型或整理成功。累计采用包括后来停用或撤回的记录，数量独立于最近 50 批整理及 100 条反馈列表。

私人读取先验证当前登录人与具体实例归属。历史可读不代表仍可采用；来源撤回、实例归档或技能失效后保留历史与原证明，运行时权限检查不变。组织后台使用单独的严格汇总投影，仅返回策略、时间、状态和数量，不调用 owner 接口、不返回私人规则、反馈、技能版本或来源正文。平台模板没有单一公司频率，显示按所在公司策略执行。

详情保持只读，纠正已采用经验仍通过聊天。旧“经验记录”页面保留人工历史与本人撤回动作，复用原有 DELETE memory 事务，防止失去对原始反馈和旧人工候选的控制。旧创建、批准 HTTP POST 返回 `410 LEGACY_EXPERIENCE_WRITE_RETIRED`，不再提供手填或审批表单；自动采集、整理、验证、采用和遗忘均继续使用现有服务端机制。不能关闭整个经验 feature flag 来代替旧入口退役。

页面按账号、工作区和实例隔离，关闭或切换会取消请求，迟到响应不能替换当前内容。重新读取权限失败立即清除旧内容，无持续轮询。PR4 的实际页面验收复用既有采用与停用证据，不为展示重跑模型任务。

## 精确来源与派生索引（MET184 PR1）

本人在已采用经验下点击“查看来源与版本”，按需读取完整原始反馈、准确任务/消息身份、采用版本及实际个人 Skill pin。每次展开重查当前用户、实例、来源、内容版本和 Skill；关闭后不保留可重新显示的响应，晚到请求不能覆盖新内容。组织后台仍只见汇总，不能通过此 API 查看其他员工的私人来源。GET 不修改索引、不启动任务、不提供任意会话或文件读取权限。

迁移 0184 在现有 RAG 条目增加可删除重建的 `experience_projection`，权威仍是 Memory、修订及不可变采用证明。投影固定 `validated-rule-v1`、主题、完整规则和适用条件、准确经验 pin、草稿/来源/输出摘要。现有规则很短，使用确定性提取保留全部条件和数字；没有另调模型生成摘要，也不声称节省 token。

新采用事务同时写投影；旧记录在新 Run 当前授权检查后按需幂等重建。重建与遗忘共用来源/内容锁，派生缓存失败用 savepoint 回退，不改变原文、版本或任务模型调用。读取比较完整预期投影；缺失、旧算法或损坏时只返回同一已授权规则的完整原文。权限或来源失效必须拒绝，不能按缓存成功或历史可见性回退。遗忘仍删除整个 RAG 条目，墓碑不可由重建恢复。

这一片不改变已有模型召回及其有限规则族，模型展开和累计预算归 MET184 PR2，收益测量归 PR3，整体角色/三组对照归 PR4。当前最多三种语义身份（包括墓碑）不是通用无限经验增长能力；旧资料固定版本仍沿用原 resolver，不由此索引重解释。

## 回归入口

- `packages/contracts/src/experience-adoption.test.ts`：完整规则、边界、明确反馈、遗忘原话。
- `packages/database/src/experience-consolidation.integration.test.ts`：真实迁移、同实例/账号隔离、幂等、延后验证、取消/租约、遗忘及上下文失效。
- `packages/database/src/employees/employee-content.integration.test.ts`：原生历史及内容权限相邻回归。
- `apps/worker/test/p25/experience-{consolidation,validation}-native.test.ts`：既有 DSH 原生链路。
- `apps/web/app/workspace/experience/experience-panel.test.tsx`：实际状态及覆盖范围文案。

Dev 验收复用原反馈和 PR434 的专项验证证明，只新增跨会话采用、聊天遗忘及后续不再加载的必要任务。保留原记录，检查数据库读取凭据、原生输入、页面刷新和账本；不依赖模型口头确认。

### Report-style recognition

Report preferences use complete, finite presentation and scope clauses, including
multi-point reports with no specified format. The original rule and applicability
remain in the adopted memory and projection; a report keyword only selects recall
candidates, and never proves the request satisfies every scope condition. Explicit
task formatting still takes precedence. Extra business actions, unknown clauses,
contradictory scope and punctuation that splits a negation are rejected.

`report-style-clauses-v2` records the recognizer separately from the unchanged
`report_style / version: 1` semantic key, so withdrawn preferences stay withdrawn.
Earlier proofs without this metadata remain readable. A direct-preference proof
records explicit source feedback under the current platform policy; it does not
claim that a model-proposed A/B comparison was performed. Completed batches are
not automatically reopened after a recognizer update.

## MET184: memory loading scope and limit

“加载范围” means which memories this Run can currently use; “加载上限” means how much content may be loaded. The existing tenant/owner/instance/source and Skill checks define scope. The new limit counts UTF-8 bytes of serialized memory content, **not billed tokens, money or user credits**. Actual model usage remains in the existing usage ledger.

Initial ordinary memories and validated experiences share a 6,000-byte limit, including kernel formatting and exact source handles. Complete entries are selected; an oversized entry is skipped rather than losing a condition, number or negation. `memory_context_state` freezes the selection/digest and limits in the employee Run before the first native prompt. Recovery validates the selection and retains accumulated usage. Pre-migration NULL Runs receive no fresh memory allowance; corrupt state cannot reset accounting.

`workspace.memory.search` and `workspace.experience.read` share the same Run allowance: 8,000 bytes per returned envelope, 24,000 cumulative bytes including initial loading, and 12 reads. Repeated reads consume the allowance again. This measures one initial assembly plus delivered tool content; it is not a measurement of every model context resend, compaction token cost, or a promise of cost savings. Omitted entries and unavailable sources remain explicit. These tools never export an overlarge body into a static file.

Source expansion accepts only a handle issued for this Run's exact experience pin. It rechecks the frozen tool grant, current Worker job/lease/task clock, current identity, instance, source and Skill in the same transaction that updates the allowance. Original feedback is evidence, not authorization. A derived-index failure may return the same authorized complete original, never bypass a source check. Existing experience pins remain conservative dependencies for history, compaction and references even if the initial byte limit skips a candidate.

For new Runs only, an existing `workspace.memory.search` + `storage:read` grant includes the narrower source-read companion. An old frozen tool list is never rewritten. No source locator is emitted when the tool is unavailable. Unbound platform previews cannot use these two Run-accounted memory tools. AllRice's native registration, Broker and database implement this boundary; DSH core and dependencies are unchanged.
