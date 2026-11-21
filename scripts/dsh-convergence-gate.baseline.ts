/**
 * MET-210 #4 initial inventory: main 5edb28d2, 2026-10-27.
 * Scope completed on 2026-10-28 after the first review (PR #626 task decision).
 * Tables are checked against PostgreSQL after all migrations, not SQL text.
 * 待删 is a conservative handoff, not approval of the existing implementation.
 * Delete entries with the implementation; additions need category/basis/user approval.
 */
import type { BaselineEntry } from './dsh-convergence-gate.ts';

export const baseline: readonly BaselineEntry[] = [
  {
    kind: 'table',
    id: 'person_vm_admission_permits',
    category: '租约',
    basis:
      'MET-266：跨host共享普通请求准入与freeze的线性化边界；只记宿主queued/active/deferred范围租约与owner收尾，不复制DSH任务状态。',
    approvedBy:
      '2026-11-21 用户批准AllRice共享门卫/版本租约；root已核新增PG与超原2x方案，见ADMISSION-HOST-IMPLEMENTATION-PLAN.md及本片派活。',
  },
  {
    kind: 'table',
    id: 'person_virtual_machines',
    category: '租约',
    basis:
      'MET-266 / M1-02：DSH 不管理宿主 VM 或个人加密盘。只记本人唯一盘、宿主开停/所有权租约、精确实例/epoch、连续空闲观察与停机时刻；host hold 不是原生 turn/job/子任务/审批权威，不建第二 Agent 状态机。',
    approvedBy:
      '2026-11-21 用户批准 AllRice 4.0 MET-266 产品开工，MET-265 合同 v1.0 冻结且 MET-264 基线通过；root 同日派活及新增 PG 四类核对，见本任务 PLAN.md 与 docs/architecture/person-vm.md。',
  },
  {
    kind: 'table',
    id: 'person_vm_audit',
    category: '账本',
    basis:
      'MET-266 / M1-02：只追加宿主个人盘/VM 开停、显式删盘授权与实际失败/完成回执；不从账本驱动原生 Agent 执行。DSH 不拥有宿主盘删除及租约审计。',
    approvedBy:
      '2026-11-21 用户批准 AllRice 4.0 MET-266 产品开工；root 同日确认 VM 存储/宿主租约/审计属于已批范围，见本任务 PLAN.md。',
  },
  {
    kind: 'table',
    id: 'allrice_model_gateway_calls',
    category: '账本',
    basis:
      'MET-268：VM外可信原生调用关联及不可变幂等claim，重连不重放模型请求；不存Agent执行状态。DSH不持有SaaS当前本人/VM epoch/Run计费归属。',
    approvedBy:
      '2026-11-21 MET-268用户开工授权；主会话审PLAN.md四类核定通过，calls限宿主幂等关联。',
  },
  {
    kind: 'table',
    id: 'allrice_model_gateway_attempts',
    category: '账本',
    basis:
      'MET-268：实际HTTP模型/刷新尝试及其独立响应、关闭、terminal与usage事实；dispatch intent不证明上游收到/费用，缺失为null，不用guest日志收费。',
    approvedBy:
      '2026-11-21 MET-268用户开工授权；主会话审PLAN.md四类核定通过，attempts限单向上游账本。',
  },
  {
    kind: 'table',
    id: 'allrice_model_gateway_slots',
    category: '租约',
    basis:
      'MET-268：用户每人8个活跃上游模型流，跨gateway/企业按全局personId原子领取；实际transport收敛及receipt提交才释放，无TTL或Agent生命周期。',
    approvedBy:
      '2026-11-21 MET-268用户开工授权；主会话审PLAN.md四类核定通过，slots限每人准入租约。',
  },
  {
    kind: 'patch',
    id: 'allrice-host-model-gateway-v1',
    category: '账本',
    basis:
      'MET-268：公开DSH LlmAdapter/prepareCall/StreamChunk接缝外补可信身份、实际HTTP逐尝试计量、持久准入；原生消息/工具/取消语义保留，无新loop/账户路由/扣费权威。',
    approvedBy: '2026-11-21 MET-268用户开工授权；主会话审PLAN.md四类核定通过。',
  },
  {
    kind: 'table',
    id: 'allrice_employee_module_bindings',
    category: '门卫',
    basis:
      'MET-224 快车道 P2：DSH 不拥有 SaaS 员工实例范围的插件安装授权；仅存 org/workspace/owner/instance 与精确 module/version/digest/revision、有效/撤销事实，接已有身份授权。无 Run、工具或 Skill 状态机；MET-253 接管同一存储，不双写。',
    approvedBy:
      '2026-11-16 MET-224 用户批准快车道计划及 bbb67fb2-03e6-42be-8b4b-ab4cfc2750e7；写前对照 a0a21ae4-c376-444c-8286-f7b6ccd3891f。',
  },
  {
    kind: 'table',
    id: 'allrice_assistant_artifacts',
    category: '待删',
    basis:
      'MET-210 PR2b：旧执行器已删，待销毁的被动历史；保留原行、FK、失败/unknown 和计费事实，不参与当前执行。2026-10-29 主会话按 decommission-gate-plan §4 分期，数据销毁后移；本项仍是初始待删存量。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_assistant_cost_receipts',
    category: '待删',
    basis:
      'MET-210 PR2b：旧执行器已删，待销毁的被动历史；保留原行、FK、失败/unknown 和计费事实，不参与当前执行。2026-10-29 主会话按 decommission-gate-plan §4 分期，数据销毁后移；本项仍是初始待删存量。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_assistant_instances',
    category: '待删',
    basis:
      'MET-210 PR2b：旧执行器已删，待销毁的被动历史；保留原行、FK、失败/unknown 和计费事实，不参与当前执行。2026-10-29 主会话按 decommission-gate-plan §4 分期，数据销毁后移；本项仍是初始待删存量。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_assistant_messages',
    category: '待删',
    basis:
      'MET-210 PR2b：旧执行器已删，待销毁的被动历史；保留原行、FK、失败/unknown 和计费事实，不参与当前执行。2026-10-29 主会话按 decommission-gate-plan §4 分期，数据销毁后移；本项仍是初始待删存量。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_assistant_model_admissions',
    category: '待删',
    basis:
      'MET-210 PR2b：旧执行器已删，待销毁的被动历史；保留原行、FK、失败/unknown 和计费事实，不参与当前执行。2026-10-29 主会话按 decommission-gate-plan §4 分期，数据销毁后移；本项仍是初始待删存量。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_assistant_price_snapshots',
    category: '待删',
    basis:
      'MET-210 PR2b：旧执行器已删，待销毁的被动历史；保留原行、FK、失败/unknown 和计费事实，不参与当前执行。2026-10-29 主会话按 decommission-gate-plan §4 分期，数据销毁后移；本项仍是初始待删存量。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_assistant_results',
    category: '待删',
    basis:
      'MET-210 PR2b：旧执行器已删，待销毁的被动历史；保留原行、FK、失败/unknown 和计费事实，不参与当前执行。2026-10-29 主会话按 decommission-gate-plan §4 分期，数据销毁后移；本项仍是初始待删存量。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_assistant_roots',
    category: '待删',
    basis:
      'MET-210 PR2b：旧执行器已删，待销毁的被动历史；保留原行、FK、失败/unknown 和计费事实，不参与当前执行。2026-10-29 主会话按 decommission-gate-plan §4 分期，数据销毁后移；本项仍是初始待删存量。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_assistant_usage',
    category: '待删',
    basis:
      'MET-210 PR2b：旧执行器已删，待销毁的被动历史；保留原行、FK、失败/unknown 和计费事实，不参与当前执行。2026-10-29 主会话按 decommission-gate-plan §4 分期，数据销毁后移；本项仍是初始待删存量。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_development_heads',
    category: '存储后端',
    basis:
      '旧执行器已删，待销毁的被动历史；0101/0102 的已有行及 FK 必需来源原样保留，没有生产查询/写入入口。只登记实际仍存在的历史存储，不保留协调执行能力。',
    approvedBy:
      '2026-10-29 主会话 executor-first 书面任务：按 decommission-gate-plan §4 保留17表，显式后移数据销毁；AGENTS §11 方案取舍。',
  },
  {
    kind: 'table',
    id: 'allrice_development_assignments',
    category: '存储后端',
    basis:
      '旧执行器已删，待销毁的被动历史；0101/0102 的已有行及 FK 必需来源原样保留，没有生产查询/写入入口。只登记实际仍存在的历史存储，不保留协调执行能力。',
    approvedBy:
      '2026-10-29 主会话 executor-first 书面任务：按 decommission-gate-plan §4 保留17表，显式后移数据销毁；AGENTS §11 方案取舍。',
  },
  {
    kind: 'table',
    id: 'allrice_development_proposals',
    category: '存储后端',
    basis:
      '旧执行器已删，待销毁的被动历史；0101/0102 的已有行及 FK 必需来源原样保留，没有生产查询/写入入口。只登记实际仍存在的历史存储，不保留协调执行能力。',
    approvedBy:
      '2026-10-29 主会话 executor-first 书面任务：按 decommission-gate-plan §4 保留17表，显式后移数据销毁；AGENTS §11 方案取舍。',
  },
  {
    kind: 'table',
    id: 'allrice_development_merges',
    category: '存储后端',
    basis:
      '旧执行器已删，待销毁的被动历史；0101/0102 的已有行及 FK 必需来源原样保留，没有生产查询/写入入口。只登记实际仍存在的历史存储，不保留协调执行能力。',
    approvedBy:
      '2026-10-29 主会话 executor-first 书面任务：按 decommission-gate-plan §4 保留17表，显式后移数据销毁；AGENTS §11 方案取舍。',
  },
  {
    kind: 'table',
    id: 'allrice_development_merge_sources',
    category: '存储后端',
    basis:
      '旧执行器已删，待销毁的被动历史；0101/0102 的已有行及 FK 必需来源原样保留，没有生产查询/写入入口。只登记实际仍存在的历史存储，不保留协调执行能力。',
    approvedBy:
      '2026-10-29 主会话 executor-first 书面任务：按 decommission-gate-plan §4 保留17表，显式后移数据销毁；AGENTS §11 方案取舍。',
  },
  {
    kind: 'table',
    id: 'allrice_development_verifiers',
    category: '存储后端',
    basis:
      '旧执行器已删，待销毁的被动历史；0101/0102 的已有行及 FK 必需来源原样保留，没有生产查询/写入入口。只登记实际仍存在的历史存储，不保留协调执行能力。',
    approvedBy:
      '2026-10-29 主会话 executor-first 书面任务：按 decommission-gate-plan §4 保留17表，显式后移数据销毁；AGENTS §11 方案取舍。',
  },
  {
    kind: 'table',
    id: 'allrice_development_reviews',
    category: '存储后端',
    basis:
      '旧执行器已删，待销毁的被动历史；0101/0102 的已有行及 FK 必需来源原样保留，没有生产查询/写入入口。只登记实际仍存在的历史存储，不保留协调执行能力。',
    approvedBy:
      '2026-10-29 主会话 executor-first 书面任务：按 decommission-gate-plan §4 保留17表，显式后移数据销毁；AGENTS §11 方案取舍。',
  },
  {
    kind: 'table',
    id: 'allrice_development_deliveries',
    category: '存储后端',
    basis:
      '旧执行器已删，待销毁的被动历史；0101/0102 的已有行及 FK 必需来源原样保留，没有生产查询/写入入口。只登记实际仍存在的历史存储，不保留协调执行能力。',
    approvedBy:
      '2026-10-29 主会话 executor-first 书面任务：按 decommission-gate-plan §4 保留17表，显式后移数据销毁；AGENTS §11 方案取舍。',
  },
  {
    kind: 'table',
    id: 'allrice_native_questions',
    category: '账本',
    basis:
      'MET-210 v4.5 PR4：DSH userQuestions 公开投影单向镜像；租户会话身份、任务时钟和授权证据需要 PG 查询，native_present 仅镜像集合成员资格；首次题与 closed_at 撤权事实不随原生移除丢弃，closed_at 仅是停止/回拨的 SaaS 撤权门卫。',
    approvedBy:
      '2026-10-28 主会话 PR4 草稿实现任务：核定会话账本属单向账本，运行开关为已批准上线策略。',
  },
  {
    kind: 'table',
    id: 'allrice_brand_content_reminders',
    category: '待删',
    basis:
      '0193：品牌内容专属提醒注册与派发状态；定时 plan-v2-draft-astra.md §1.2、§3：方案推荐删除，待用户确认。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_brand_native_reminder_targets',
    category: '待删',
    basis:
      '0197：品牌专属提醒目标与重试链；定时 plan-v2-draft-astra.md §1.2、§3：方案推荐删除，待用户确认。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_dsh_runtime_close_observations',
    category: '账本',
    basis:
      '0212、providers/dsh-runtime-close-observations.ts：单向持久化 Worker 观察到的原生关闭请求和物理退出证据，DSH 不维护 SaaS 发布审计；对应 allrice-observed-native-close-v1。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_dsh_runtime_instances',
    category: '账本',
    basis:
      '0044、providers/dsh-runtime-registry.ts：Worker 心跳和物理退出的运行实例投影，供租户控制台与发布核对；live/offline 是观测记录，不决定 DSH 执行生命周期。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_dsh_skills',
    category: '存储后端',
    basis:
      '0046/0084、employees/employeehub.ts：持久化租户技能内容、checksum 与 bundle，冻结后提供给 DSH；DSH 不维护 AllRice 租户技能存储和员工绑定，执行仍归 DSH。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_native_calendar_arms',
    category: '待删',
    basis:
      '0204：自写 calendar arm 创建、绑定和退休状态；能否完全交给 DSH 待主会话核定。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_native_calendar_decisions',
    category: '待删',
    basis:
      '0205：决策同时推进下一个日历周期，不能确认仅为 DSH 事件的单向账本。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_native_calendar_periods',
    category: '待删',
    basis: '0204：自写日历周期及关闭状态；是否属于必要 SaaS 逻辑待核。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_native_calendar_plans',
    category: '待删',
    basis: '0205：自写周期计划和后继计划关联；是否可由 DSH 调度替代待核。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_native_calendar_retirement_intents',
    category: '待删',
    basis: '0205：自写 Task 退休意图及决策绑定，生命周期应优先归 DSH。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_native_calendar_retirements',
    category: '待删',
    basis: '0205：退休证明参与自写日历生命周期校验，不能确认只是审计投影。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_native_context_retirements',
    category: '待删',
    basis: '0199：自写执行上下文终止标记还阻止恢复，是否应交给 DSH 待核。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_native_once_close_proofs',
    category: '待删',
    basis:
      '0195：旧 writer 关闭证明；定时 plan-v2-draft-astra.md §1.2 once 退役清单、§4.2：旧表退役，必要租约职责由新 allrice_dsh_leases 薄层承接。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_native_once_controls',
    category: '待删',
    basis:
      '0195：自写 once control 快照及任务状态约束，是否只是 DSH 存储后端待核。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_native_once_journal',
    category: '待删',
    basis:
      '0195：混有自写 mutation/command/control 快照的旧 journal；定时 plan-v2-draft-astra.md §1.2 once 退役清单、§4.2：整表退役，原生存储由新 KV/events 薄层承接。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_native_once_occurrences',
    category: '待删',
    basis: '0195：回执还驱动自写 outbox 状态与派发，不能确认仅为事件账本。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_native_once_partitions',
    category: '待删',
    basis:
      '0195：旧 once writer 的 owner/epoch/token 租约；定时 plan-v2-draft-astra.md §1.2 once 退役清单、§4.2：旧表退役，必要租约职责由新 allrice_dsh_leases 薄层承接。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_native_question_waits',
    category: '待删',
    basis:
      '0105：parked/ready/continued 等自写提问等待状态，按 MET-210 向 DSH 收敛。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_native_recurring_controls',
    category: '待删',
    basis:
      '0196：自写 recurring control 状态与 native Task 映射，存储与生命周期边界待核。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_native_recurring_journal',
    category: '待删',
    basis:
      '0196：混有自写 command/control 快照及提交证明的旧 journal；定时 plan-v2-draft-astra.md §1.2 recurring 退役清单、§4.2：整表退役，原生存储由新 KV/events 薄层承接。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_native_recurring_occurrences',
    category: '待删',
    basis: '0196：原生回执和自写 outbox 派发状态混用，是否仅为 SaaS 部分待核。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_native_recurring_operations',
    category: '待删',
    basis:
      '0196：重复任务操作另有 pending/applied/rejected 状态，优先由 DSH 执行。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_native_recurring_versions',
    category: '待删',
    basis:
      '0196：自写 recurring 版本配置与生命周期关联，是否仅存产品参数待核。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_native_session_bindings',
    category: '存储后端',
    basis:
      '0187：持久化 DSH 会话与租户存储命名空间、执行包的绑定，DSH 不维护 AllRice 租户。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_native_task_dispatches',
    category: '待删',
    basis:
      '0105：自写 started/parked/completed 派发状态，与 DSH 执行生命周期的边界待核。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'patch',
    id: 'allrice-host-native-history-v1',
    category: '存储后端',
    basis:
      'MET-274：DSH rc.2 公开 inspect/append-origin 提供原生历史语义，但不提供 VM 停机时的 SaaS 宿主持久读权或精确附件字节服务。宿主不可变投影属存储后端；既有本人/root/子会话与对象现权属门卫，单向文本/工具展示属账本；不新增 Agent 状态机、恢复器或自动重放。',
    approvedBy:
      '2026-11-21 用户 MET274 派活；冻结边界合同 v1 §5/7/9；MET274 评论 ef9ce0b2。FIX1 下载完整性、撤权与取消修复沿用同一授权范围。',
  },
  {
    kind: 'patch',
    id: 'allrice-reference-read-v1',
    category: '业务工具',
    basis:
      'MET-247 R3/R4a/R4b v1.8：通过 DSH 公开 defineTool/register 接缝提供企业资料检索、精确文字、静态图片及按需 ZIP 目录/成员读取；图片复用当前路由、公开附件存储及 image block。DSH 不持有 AllRice publication 当前租户权限、固定副本事实或实际读取账本，复用现 Broker、权限门卫、Worker 租约和 reference_reads，不新增 Agent 生命周期或图片状态机。',
    approvedBy:
      '2026-11-15 用户明确授权叠 R0 #860 e38d3159 开发 R4a，再叠 363b47ae 开发 R4b；MET-247 v1.8 已审定文档 eb4f27e192fa、规划回复 e5758419（f77a2d53 下回复）批准 A–D；原 R3 授权与 v1.7 历史边界沿用。',
  },
  {
    kind: 'patch',
    id: 'allrice-brand-content-read-v1',
    category: '业务工具',
    basis:
      'MET-194：通过公开工具接缝提供品牌业务内容读取；依据 AGENTS.md §0“界面和业务工具照常做”，不新增 Agent 生命周期。',
    approvedBy:
      '2026-10-28 任务说明：主会话决定第 (5) 项，品牌内容读取适配归业务工具。',
  },
  {
    kind: 'patch',
    id: 'allrice-observed-model-recovery-v1',
    category: '待删',
    basis: '请求诊断与空闲恢复干预 DSH 重试时机；不确定仍有必要，待核。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'patch',
    id: 'allrice-progressive-scene-provider-v1',
    category: '门卫',
    basis:
      'MET-179：公开 Skill Provider 读取前核对租户内容权限；DSH 不维护 AllRice 内容授权。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'patch',
    id: 'allrice-employee-documents-v1',
    category: '门卫',
    basis:
      'DSH owns native context snapshots and fork/resume. AllRice alone knows current tenant/owner/employee-instance confirmation, bounded document selection and the existing Run ledger. Only public exact-Agent scope is used.',
    approvedBy:
      '2026-11-04 用户批准 MET-246 M3 方案及原生继承边界：冻结 child 自身当前配置，允许 fork 继承 root 已完成文档快照。',
  },
  {
    kind: 'patch',
    id: 'allrice-employee-content-authorization-v1',
    category: '门卫',
    basis:
      'MET-179：在公开 llm/stream 接缝检查租户内容撤权，DSH 不维护 AllRice 权限。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'patch',
    id: 'allrice-codex-overload-normalization-v1',
    category: '待删',
    basis: '按特定错误文案改写 DSH 原生错误类型与重试行为，是否仍需适配待核。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'patch',
    id: 'allrice-office-native-v1',
    category: '业务工具',
    basis:
      'MET-157：Office 业务工具参数适配；依据 AGENTS.md §0“界面和业务工具照常做”，通过工具接缝对接业务参数，不接管 Agent 生命周期。',
    approvedBy:
      '2026-10-28 任务说明：主会话决定第 (5) 项，Office 适配归业务工具。',
  },
  {
    kind: 'patch',
    id: 'allrice-durable-native-question-wait-v1',
    category: '待删',
    basis: 'MET-153：自写提问挂起、恢复和主机释放，按 MET-210 向 DSH 收敛。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'patch',
    id: 'allrice-durable-progress-guard-v1',
    category: '待删',
    basis: 'MET-153：自写重复失败暂停和提问控制，是否可恢复 DSH 语义待核。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'patch',
    id: 'allrice-durable-task-clock-v1',
    category: '待删',
    basis:
      'MET-210 PR2b 已删旧助手 join/flush；仍保留普通 Run 的任务时钟投影，未改变此待核分类。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'patch',
    id: 'allrice-repository-review-native-v1',
    category: '业务工具',
    basis:
      'MET-210 PR2a：DSH 公开 defineTool/register/restrict 接缝提供独立仓库复核业务工具及完整工具名单门卫，权限/租约与不可变意见仍为门卫/账本；不新增 Agent 生命周期。',
    approvedBy:
      '2026-10-28 / 29 用户 PR2a 独立复核修复任务说明：原生注册、Agent 工具限制门卫、Host allowlist 和真实 function-call；AGENTS.md §0 业务工具。',
  },
  {
    kind: 'patch',
    id: 'allrice-workbench-native-changeset-v1',
    category: '业务工具',
    basis:
      'MET-147：通过公开工具接缝提供 Broker changeset 提案参数，保留业务批准和文件 CAS；依据 AGENTS.md §0“界面和业务工具照常做”。',
    approvedBy:
      '2026-10-28 任务说明：主会话决定第 (5) 项，workbench changeset 适配归业务工具。',
  },
  {
    kind: 'patch',
    id: 'allrice-bounded-native-search-v1',
    category: '待删',
    basis: 'MET-150：搜索经 Broker 授权且裁剪结果，是否只是门卫和存储待核。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'patch',
    id: 'allrice-jsonrpc-lifecycle-v1',
    category: '待删',
    basis: 'MET-85：自写 Host 生命周期、恢复和等待包装，四类之外部分待核。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'patch',
    id: 'allrice-session-reference-v1',
    category: '门卫',
    basis:
      '公开 SessionReferenceResolver 只返回已授权的租户消息；DSH 不维护 AllRice 消息权限。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'patch',
    id: 'allrice-managed-native-mcp-public-v2',
    category: '门卫',
    basis:
      'MET-192：公开 MCP 接缝检查租户授权、出口与 OAuth，DSH 不维护 AllRice 租户凭证权限。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'patch',
    id: 'allrice-private-v4-payload-validation-v2',
    category: '待删',
    basis: 'MET-192：四种 AllRice 私有会话事件及顺序校验，随私有事件一起收敛。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'patch',
    id: 'allrice-final-delivery-v1',
    category: '待删',
    basis:
      'MET-210 PR1b：独立根 Run 仅保留 SaaS 权限/持久化门卫，公开 wait 后一次平台 steer 修正；PR2b 已删除旧助手同回合包装，资格与 PR1c 同窗放开；分类保留原待删基线，未擅自重新核定。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'patch',
    id: 'allrice-observed-native-close-v1',
    category: '账本',
    basis:
      'MET-195：单向记录公开 shutdown/dispose 的关闭结果与 Worker 观察，供 SaaS 审计。',
    approvedBy: 'baseline 2026-10-27',
  },
];
