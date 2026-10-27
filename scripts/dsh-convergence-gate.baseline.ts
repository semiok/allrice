/**
 * MET-210 #4 initial inventory: main 5edb28d2, 2026-10-27.
 * Tables are checked against PostgreSQL after all migrations, not SQL text.
 * 待删 is a conservative handoff, not approval of the existing implementation.
 * Delete entries with the implementation; additions need category/basis/user approval.
 */
import type { BaselineEntry } from './dsh-convergence-gate.ts';

export const baseline: readonly BaselineEntry[] = [
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
    category: '租约',
    basis:
      '0195：持久化 Worker writer epoch 的关闭证明，支撑跨 Worker 租约交接。',
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
    category: '存储后端',
    basis:
      '0195：持久化 native Task/workspace 写入日志与快照，供原生日志恢复。',
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
    category: '租约',
    basis:
      '0195：跨 Worker writer 的 owner、epoch、token 和过期时间，DSH 不负责 SaaS Worker 领取。',
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
    category: '存储后端',
    basis: '0196：持久化 native recurring 写入日志与快照，供原生日志恢复。',
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
    category: '待删',
    basis:
      'MET-194：品牌业务读取工具接缝；能否归入四类或保留为业务工具由主会话核定。',
    approvedBy: 'baseline 2026-10-27',
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
    category: '待删',
    basis:
      'MET-157：Office 业务工具参数适配；是否属于四类或业务工具例外由主会话核定。',
    approvedBy: 'baseline 2026-10-27',
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
    category: '待删',
    basis:
      'MET-147：业务 changeset 工具适配；是否归四类或业务工具例外由主会话核定。',
    approvedBy: 'baseline 2026-10-27',
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
      'MET-184/MET-192：自写最终交付认证和同回合纠正，DSH 之外的生命周期待核。',
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
