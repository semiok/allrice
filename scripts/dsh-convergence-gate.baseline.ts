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
    id: 'allrice_native_questions',
    category: '账本',
    basis:
      'MET-210 v4.5 PR4：DSH userQuestions 公开投影单向镜像；租户会话身份、任务时钟和授权证据需要 PG 查询，native_present 仅镜像集合成员资格；首次题与 closed_at 撤权事实不随原生移除丢弃，closed_at 仅是停止/回拨的 SaaS 撤权门卫。',
    approvedBy:
      '2026-10-28 主会话 PR4 草稿实现任务：核定会话账本属单向账本，运行开关为已批准上线策略。',
  },
  {
    kind: 'table',
    id: 'allrice_assistant_artifacts',
    category: '待删',
    basis:
      '0093：旧助手成果命名空间；子智能体 plan-v3-draft-astra.md §2 PR2b 九表退役，独立交付先上线。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_assistant_cost_receipts',
    category: '待删',
    basis:
      '0096：依赖旧助手的计费回执；子智能体 plan-v3-draft-astra.md §2 PR2b 九表退役，保留通用订阅和账本。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_assistant_instances',
    category: '待删',
    basis:
      '0093：旧助手实例与自写执行状态；子智能体 plan-v3-draft-astra.md §2 PR2b 九表退役，生命周期回归 DSH。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_assistant_messages',
    category: '待删',
    basis:
      '0093：旧助手消息队列与投递状态；子智能体 plan-v3-draft-astra.md §2 PR2b 九表退役，消息由 DSH 管理。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_assistant_model_admissions',
    category: '待删',
    basis:
      '0095：旧助手两阶段模型准入；子智能体 plan-v3-draft-astra.md §2 PR2b 九表退役，不删除通用预算设施。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_assistant_price_snapshots',
    category: '待删',
    basis:
      '0096：旧助手根计价快照；子智能体 plan-v3-draft-astra.md §2 PR2b 九表退役，保留订阅共用的不可变触发函数。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_assistant_results',
    category: '待删',
    basis:
      '0093：旧助手 report 结果协议；子智能体 plan-v3-draft-astra.md §2 PR2b 九表退役，须先完成独立交付链。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_assistant_roots',
    category: '待删',
    basis:
      '0093：旧助手根配置与 generation/fence；子智能体 plan-v3-draft-astra.md §2 PR2b 九表退役，保留通用 runtime_roots。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'table',
    id: 'allrice_assistant_usage',
    category: '待删',
    basis:
      '0093：依赖旧助手实例的用量预留与结算；子智能体 plan-v3-draft-astra.md §2 PR2b 九表退役，原生用量归通用根账本。',
    approvedBy: 'baseline 2026-10-27',
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
    basis: 'MET-153：自写根时钟与等待生命周期，是否仅为 SaaS 租约部分待核。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'patch',
    id: 'allrice-development-workflow-v1',
    category: '待删',
    basis:
      'MET-144：自写子代理开发协作与评审流程，按 MET-210 子代理收敛计划核定。',
    approvedBy: 'baseline 2026-10-27',
  },
  {
    kind: 'patch',
    id: 'allrice-assistant-required-delivery-v1',
    category: '待删',
    basis: 'MET-151：自写子代理交付权限和结果校验混用，按冻结包装层规则待核。',
    approvedBy: 'baseline 2026-10-27',
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
      'MET-210 PR1b：独立根 Run 仅保留 SaaS 权限/持久化门卫，公开 wait 后一次平台 steer 修正；旧助手同回合包装仍待 PR2b 删除，资格由 PR1c 同窗放开。',
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
  {
    kind: 'private-interface',
    id: 'dsh-subagent-host-prompt: @deepseek-ai/dsh-subagent/internal',
    category: '待删',
    basis:
      'compatibility.json：子代理包装层使用私有 host prompt 入口，公开替代接缝待主会话核定。',
    approvedBy: 'baseline 2026-10-27',
  },
];
