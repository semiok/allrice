import { randomUUID } from 'node:crypto';

import {
  AutomationRunSchema,
  AutomationSchema,
  AutomationScheduleSchema,
  CreateAutomationInputSchema,
  type ExecutionContext,
  RequestContextSchema,
  UpdateAutomationInputSchema,
  UuidSchema,
  type Automation,
  type AutomationRun,
  type Membership,
  type RequestContext,
} from '@allrice/contracts';

import { DataAccessError } from '../data.ts';
import { getDatabase } from '../core/client.ts';
import {
  ensureDefaultEmployee,
  resolveWorkspaceId,
} from '../workspace/service.ts';

type AutomationRunStatus = AutomationRun['status'];

interface AutomationRow {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  name: string;
  description: string;
  prompt: string;
  trigger_type: 'schedule';
  schedule: unknown;
  status: 'enabled' | 'paused';
  conversation_mode: 'new_each_run' | 'reuse';
  employee_assignment_id: string | null;
  session_id: string | null;
  last_session_id: string | null;
  next_run_at: Date | null;
  last_run_at: Date | null;
  last_run_status: AutomationRunStatus | null;
  created_at: Date;
  updated_at: Date;
}

interface AutomationRunRow {
  id: string;
  organization_id: string;
  workspace_id: string;
  automation_id: string;
  run_id: string | null;
  session_id: string | null;
  status: AutomationRunStatus;
  scheduled_for: Date;
  started_at: Date | null;
  completed_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
}

interface AutomationClaim {
  automation: Automation;
  automationRun: AutomationRun;
}

function userId(context: RequestContext) {
  if (context.actor.type !== 'user') {
    throw new DataAccessError('authentication_required');
  }
  return context.actor.id;
}

function mapAutomation(row: AutomationRow): Automation {
  const schedule = AutomationScheduleSchema.parse(row.schedule);
  return AutomationSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    name: row.name,
    description: row.description,
    prompt: row.prompt,
    triggerType: row.trigger_type,
    schedule,
    status: row.status,
    conversationMode: row.conversation_mode,
    employeeAssignmentId: row.employee_assignment_id,
    lastSessionId: row.last_session_id ?? row.session_id,
    nextRunAt: row.next_run_at?.toISOString() ?? null,
    lastRunAt: row.last_run_at?.toISOString() ?? null,
    lastRunStatus: row.last_run_status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function mapAutomationRun(row: AutomationRunRow): AutomationRun {
  return AutomationRunSchema.parse({
    id: row.id,
    automationId: row.automation_id,
    runId: row.run_id,
    sessionId: row.session_id,
    status: row.status,
    scheduledFor: row.scheduled_for.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
  });
}

function dateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
  };
}

function timeZoneOffset(date: Date, timeZone: string) {
  const parts = dateParts(date, timeZone);
  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) -
    date.getTime()
  );
}

function zonedTimeToUtc(
  input: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
  },
  timeZone: string,
) {
  const guess = new Date(
    Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute),
  );
  return new Date(guess.getTime() - timeZoneOffset(guess, timeZone));
}

function nextScheduleAt(scheduleInput: unknown, after = new Date()) {
  const schedule = AutomationScheduleSchema.parse(scheduleInput);
  if (schedule.frequency === 'once') return new Date(schedule.runAt!);
  const time = schedule.time!.split(':').map(Number);
  const current = dateParts(after, schedule.timezone);
  const candidate = new Date(
    Date.UTC(current.year, current.month - 1, current.day, time[0], time[1]),
  );
  let days = 0;
  const currentWeekday = new Date(
    Date.UTC(current.year, current.month - 1, current.day),
  ).getUTCDay();
  if (schedule.frequency === 'weekly') {
    days = ((schedule.weekday ?? 0) - currentWeekday + 7) % 7;
    if (
      days === 0 &&
      candidate.getTime() <=
        new Date(
          Date.UTC(
            current.year,
            current.month - 1,
            current.day,
            current.hour,
            current.minute,
          ),
        ).getTime()
    )
      days = 7;
  } else if (
    candidate.getTime() <=
    new Date(
      Date.UTC(
        current.year,
        current.month - 1,
        current.day,
        current.hour,
        current.minute,
      ),
    ).getTime()
  ) {
    days = 1;
  }
  candidate.setUTCDate(candidate.getUTCDate() + days);
  return zonedTimeToUtc(
    {
      year: candidate.getUTCFullYear(),
      month: candidate.getUTCMonth() + 1,
      day: candidate.getUTCDate(),
      hour: candidate.getUTCHours(),
      minute: candidate.getUTCMinutes(),
    },
    schedule.timezone,
  );
}

function canAccessWorkspace(context: RequestContext, workspaceId: string) {
  const actor = userId(context);
  return context.memberships.some(
    (membership) =>
      membership.active &&
      membership.userId === actor &&
      membership.organizationId === context.organizationId &&
      (membership.workspaceId === null ||
        membership.workspaceId === workspaceId),
  );
}

function assertOwner(context: RequestContext, row: AutomationRow) {
  if (row.owner_id !== userId(context))
    throw new DataAccessError('authorization_denied');
}

async function getAutomationRow(
  context: RequestContext,
  workspaceId: string,
  automationId: string,
) {
  const sql = getDatabase();
  const rows = await sql<AutomationRow[]>`
    select a.*, latest.status as last_run_status,
      latest.session_id as last_session_id
    from allrice_automations a
    left join lateral (
      select r.status, r.session_id from allrice_automation_runs r
      where r.automation_id = a.id
      order by r.created_at desc
      limit 1
    ) latest on true
    where a.organization_id = ${context.organizationId}
      and a.workspace_id = ${UuidSchema.parse(workspaceId)}
      and a.id = ${UuidSchema.parse(automationId)}
  `;
  const row = rows[0];
  if (!row) throw new DataAccessError('not_found');
  assertOwner(context, row);
  return row;
}

const demoAutomationTemplates = [
  {
    name: '每日经营晨报',
    description: '传统文化企业每日经营数据、订单和客户动态摘要。',
    employeeKey: 'builtin-ecommerce-analyst',
    schedule: {
      frequency: 'daily' as const,
      time: '09:00',
      timezone: 'Asia/Shanghai',
    },
    prompt:
      '请整理昨天的经营晨报。结合工作区中的销售数据、订单、客户记录和相关文件，输出：一、核心经营指标；二、较前日的变化；三、异常和风险；四、需要老板关注的三件事；五、今天建议推进的行动。不要编造缺失数据，明确标注数据来源和待补充信息。',
  },
  {
    name: '传统文化内容选题策划',
    description: '围绕节气、非遗、传统工艺和品牌故事生成内容选题。',
    employeeKey: 'builtin-short-video-growth',
    schedule: {
      frequency: 'weekly' as const,
      time: '09:30',
      weekday: 1,
      timezone: 'Asia/Shanghai',
    },
    prompt:
      '请为本周制定传统文化内容选题计划。结合近期节气、传统节日、非遗文化、用户兴趣和品牌定位，输出至少 8 个短视频或图文选题，每个包含标题、核心观点、内容结构、开头 3 秒话术、适合的素材和发布建议，并标注优先级。',
  },
  {
    name: '客户与项目跟进提醒',
    description: '整理重点客户、合作项目和即将逾期的跟进事项。',
    employeeKey: 'builtin-sales-coach',
    schedule: {
      frequency: 'weekly' as const,
      time: '16:30',
      weekday: 5,
      timezone: 'Asia/Shanghai',
    },
    prompt:
      '请整理本周客户与项目跟进情况。根据工作区中的客户记录、合作项目和对话，输出重点客户状态、已承诺事项、待跟进事项、潜在风险和下周跟进话术。按紧急程度排序，不确定的信息请列为待确认。',
  },
  {
    name: '文化活动效果复盘',
    description: '复盘展览、课程、文创活动或线上活动的效果并提出改进建议。',
    employeeKey: 'builtin-growth-strategist',
    schedule: {
      frequency: 'weekly' as const,
      time: '17:00',
      weekday: 5,
      timezone: 'Asia/Shanghai',
    },
    prompt:
      '请复盘本周的传统文化活动、展览、课程或营销项目。重点分析参与人数、转化、收入、内容传播、客户反馈和执行成本；输出活动结论、做得好的地方、问题根因、下一次应该停止或继续的事项，以及一份可执行的优化清单。',
  },
  {
    name: '活动页与商品文案优化',
    description: '持续检查文化产品和活动页面的卖点、结构与转化路径。',
    employeeKey: 'builtin-ecommerce-page-builder',
    schedule: {
      frequency: 'weekly' as const,
      time: '10:00',
      weekday: 3,
      timezone: 'Asia/Shanghai',
    },
    prompt:
      '请检查本周需要推广的文化产品、课程或活动页面。结合已有资料和历史反馈，给出页面结构、主标题、副标题、核心卖点、信任证明、用户疑虑处理和行动按钮建议；同时指出当前页面最可能影响转化的三个问题。',
  },
  {
    name: '传统文化知识库整理',
    description: '整理企业积累的文化资料、产品知识和讲解口径。',
    employeeKey: 'builtin-cultural-researcher',
    schedule: {
      frequency: 'weekly' as const,
      time: '10:30',
      weekday: 3,
      timezone: 'Asia/Shanghai',
    },
    prompt:
      '请整理本周新增的传统文化资料、产品资料、活动记录和客户常见问题。输出结构化知识卡片，包含主题、事实依据、可用于对外传播的表达、不可确认的信息和关联产品；发现重复或矛盾内容时请标记出来。',
  },
  {
    name: '非遗项目进度周报',
    description: '汇总非遗项目、合作方和重点交付节点，提前识别风险。',
    employeeKey: 'builtin-growth-strategist',
    schedule: {
      frequency: 'weekly' as const,
      time: '09:00',
      weekday: 1,
      timezone: 'Asia/Shanghai',
    },
    prompt:
      '请生成非遗项目进度周报。按项目列出本周进展、已完成交付、待办事项、负责人、截止时间、合作方反馈和风险；最后给老板输出一页式总览，标记需要决策、需要协调和可以继续推进的事项。',
  },
  {
    name: '文创产品上新计划',
    description: '从文化主题、用户需求和销售目标出发规划文创产品上新。',
    employeeKey: 'builtin-ecommerce-page-builder',
    schedule: {
      frequency: 'weekly' as const,
      time: '11:00',
      weekday: 2,
      timezone: 'Asia/Shanghai',
    },
    prompt:
      '请制定本周文创产品上新计划。结合现有产品资料、传统文化主题、用户反馈和销售目标，输出产品定位、文化故事、目标人群、价格带、主图与详情页卖点、发布节奏和首周验证指标。对缺少依据的判断请标注假设。',
  },
  {
    name: '展览与活动筹备清单',
    description: '把展览、讲座、研学和文化活动拆解为可执行的筹备任务。',
    employeeKey: 'builtin-growth-strategist',
    schedule: {
      frequency: 'weekly' as const,
      time: '14:00',
      weekday: 2,
      timezone: 'Asia/Shanghai',
    },
    prompt:
      '请检查近期展览、讲座、研学或文化活动的筹备情况。按时间倒排输出场地、内容、嘉宾、物料、宣传、报名、现场执行和复盘任务，标注负责人、截止时间、依赖关系和当前风险，最后给出本周最重要的五项推进动作。',
  },
  {
    name: '文化课程与研学复盘',
    description: '分析课程、研学和讲解项目的参与体验与交付质量。',
    employeeKey: 'builtin-cultural-course-planner',
    schedule: {
      frequency: 'weekly' as const,
      time: '16:00',
      weekday: 4,
      timezone: 'Asia/Shanghai',
    },
    prompt:
      '请复盘本周文化课程、研学活动或讲解服务。分析报名、到场、满意度、复购、投诉、讲师表现和客户反馈，提炼最受欢迎的内容与体验问题，并提出课程优化、服务改进和下一次销售跟进建议。',
  },
  {
    name: '品牌故事素材提炼',
    description: '从企业历史、技艺传承和客户案例中提炼品牌传播素材。',
    employeeKey: 'builtin-cultural-brand-storyteller',
    schedule: {
      frequency: 'weekly' as const,
      time: '15:00',
      weekday: 4,
      timezone: 'Asia/Shanghai',
    },
    prompt:
      '请从本周新增的企业历史、传承故事、工艺资料、客户案例和活动记录中提炼品牌传播素材。输出 3 个品牌故事、5 个短视频切入点、2 个客户案例表达和可直接使用的金句；区分已核实事实与需要补充的信息。',
  },
  {
    name: '客户定制方案初稿',
    description: '根据客户需求快速形成文化项目、礼赠或活动定制方案。',
    employeeKey: 'builtin-sales-coach',
    schedule: {
      frequency: 'daily' as const,
      time: '15:30',
      timezone: 'Asia/Shanghai',
    },
    prompt:
      '请检查近期新增的客户需求和合作沟通，整理需要推进的定制项目。为每个项目形成方案初稿，包含客户目标、文化主题、产品或服务组合、交付方式、时间计划、预算信息、待确认问题和下一步沟通话术。',
  },
  {
    name: '用户反馈与舆情周报',
    description: '汇总用户评价、客服反馈和公开传播中的问题与机会。',
    employeeKey: 'builtin-ecommerce-analyst',
    schedule: {
      frequency: 'weekly' as const,
      time: '17:30',
      weekday: 5,
      timezone: 'Asia/Shanghai',
    },
    prompt:
      '请生成用户反馈与舆情周报。汇总客户评价、客服记录、活动反馈和公开内容中的正向反馈、常见问题、负面风险和潜在需求，按影响范围和紧急程度排序，并给出产品、内容、服务和管理四个方面的改进建议。',
  },
  {
    name: '经营会议材料',
    description: '把经营数据、项目进展和文化业务成果整理成老板会议材料。',
    employeeKey: 'builtin-ecommerce-analyst',
    schedule: {
      frequency: 'weekly' as const,
      time: '09:00',
      weekday: 1,
      timezone: 'Asia/Shanghai',
    },
    prompt:
      '请准备月度经营会议材料。综合本月收入、订单、客户、产品、活动、内容、项目和团队事项，输出结论先行的经营摘要、关键数据、重点成果、问题与风险、需要老板决策的事项以及下月行动计划。没有月度数据时请使用已有资料并明确缺口。',
  },
] as const;

async function ensureDemoAutomations(
  context: RequestContext,
  workspaceId: string,
) {
  await ensureDefaultEmployee(context, workspaceId);
  const sql = getDatabase();
  const existing = await sql<{ name: string }[]>`
    select name from allrice_automations
    where organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId}
      and owner_id = ${userId(context)}
      and name in ${sql(demoAutomationTemplates.map((template) => template.name))}
  `;
  const existingNames = new Set(existing.map((row) => row.name));
  const assignments = await sql<{ employee_key: string; id: string }[]>`
    select e.employee_key, a.id
    from allrice_employee_assignments a
    join allrice_employees e on e.id = a.employee_id
    where a.organization_id = ${context.organizationId}
      and a.workspace_id = ${workspaceId}
      and a.user_id = ${userId(context)}
      and a.active
      and e.status = 'active'
  `;
  const assignmentByKey = new Map(
    assignments.map((assignment) => [assignment.employee_key, assignment.id]),
  );
  const ownerId = userId(context);
  await sql.begin(async (transaction) => {
    for (const template of demoAutomationTemplates) {
      if (existingNames.has(template.name)) continue;
      const employeeAssignmentId =
        assignmentByKey.get(template.employeeKey) ??
        assignmentByKey.get('default-assistant') ??
        null;
      const rows = await transaction<{ id: string }[]>`
        insert into allrice_automations (
          organization_id, workspace_id, owner_id, name, description, prompt,
          trigger_type, schedule, status, conversation_mode,
          employee_assignment_id, next_run_at
        ) values (
          ${context.organizationId}, ${workspaceId}, ${ownerId},
          ${template.name}, ${`演示模板 · ${template.description}`},
          ${template.prompt}, 'schedule', ${transaction.json(template.schedule)},
          'paused', 'new_each_run', ${employeeAssignmentId}, null
        ) returning id
      `;
      if (!rows[0]) throw new Error('demo automation creation failed');
      await transaction`
        insert into allrice_audit_events (
          organization_id, workspace_id, actor_id, action, resource_type,
          resource_id, decision, reason, request_id
        ) values (
          ${context.organizationId}, ${workspaceId}, ${ownerId},
          'automation.create', 'automation', ${rows[0].id}, 'allowed',
          'seeded_traditional_culture_demo_template', ${context.requestId}
        )
      `;
    }
  });
}

async function audit(
  context: RequestContext,
  workspaceId: string,
  action: string,
  resourceId: string,
) {
  const sql = getDatabase();
  await sql`
    insert into allrice_audit_events (
      organization_id, workspace_id, actor_id, action, resource_type,
      resource_id, decision, reason, request_id
    ) values (
      ${context.organizationId}, ${workspaceId}, ${userId(context)}, ${action},
      'automation', ${resourceId}, 'allowed', 'automation_owner', ${context.requestId}
    )
  `;
}

export async function listAutomations(
  context: RequestContext,
  workspaceIdInput?: string,
) {
  const workspaceId = await resolveWorkspaceId(context, workspaceIdInput);
  if (!canAccessWorkspace(context, workspaceId))
    throw new DataAccessError('authorization_denied');
  await ensureDemoAutomations(context, workspaceId);
  const sql = getDatabase();
  const rows = await sql<AutomationRow[]>`
    select a.*, latest.status as last_run_status,
      latest.session_id as last_session_id
    from allrice_automations a
    left join lateral (
      select r.status, r.session_id from allrice_automation_runs r
      where r.automation_id = a.id
      order by r.created_at desc
      limit 1
    ) latest on true
    where a.organization_id = ${context.organizationId}
      and a.workspace_id = ${workspaceId}
      and a.owner_id = ${userId(context)}
    order by a.updated_at desc, a.created_at desc, a.id desc
  `;
  return { workspaceId, automations: rows.map(mapAutomation) };
}

export async function createAutomation(
  context: RequestContext,
  input: unknown,
) {
  const parsed = CreateAutomationInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(context, parsed.workspaceId);
  if (!canAccessWorkspace(context, workspaceId))
    throw new DataAccessError('authorization_denied');
  const nextRunAt = parsed.enabled ? nextScheduleAt(parsed.schedule) : null;
  if (parsed.employeeAssignmentId) {
    const sql = getDatabase();
    const assignment = await sql<{ id: string }[]>`
      select id from allrice_employee_assignments
      where id = ${parsed.employeeAssignmentId}
        and organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId}
        and user_id = ${userId(context)} and active
    `;
    if (!assignment[0]) throw new DataAccessError('authorization_denied');
  }
  const sql = getDatabase();
  const rows = await sql<AutomationRow[]>`
    insert into allrice_automations (
      organization_id, workspace_id, owner_id, name, description, prompt,
      trigger_type, schedule, status, conversation_mode,
      employee_assignment_id, next_run_at
    ) values (
      ${context.organizationId}, ${workspaceId}, ${userId(context)}, ${parsed.name},
      ${parsed.description}, ${parsed.prompt}, ${parsed.triggerType},
      ${sql.json(parsed.schedule)}, ${parsed.enabled ? 'enabled' : 'paused'},
      ${parsed.conversationMode},
      ${parsed.employeeAssignmentId ?? null}, ${nextRunAt}
    ) returning *, null::text as last_run_status,
      null::uuid as last_session_id
  `;
  const row = rows[0];
  if (!row) throw new Error('automation creation failed');
  await audit(context, workspaceId, 'automation.create', row.id);
  return mapAutomation(row);
}

export async function createAutomationFromExecutionContext(input: {
  context: ExecutionContext;
  sessionId?: string;
  name: string;
  prompt: string;
  delayMinutes: number;
}) {
  const { context } = input;
  const workspaceId = context.workspaceId;
  const ownerId = context.policySnapshot.subjectId;
  if (
    !workspaceId ||
    context.policySnapshot.organizationId !== context.organizationId ||
    context.policySnapshot.subjectId !== context.delegatedBy.id ||
    !context.policySnapshot.grants.some(
      (grant) =>
        grant.resourceType === 'automation' &&
        grant.action === 'resource:write' &&
        (grant.workspaceId === null || grant.workspaceId === workspaceId),
    )
  ) {
    throw new DataAccessError('authorization_denied');
  }
  if (!Number.isInteger(input.delayMinutes) || input.delayMinutes < 1) {
    throw new DataAccessError('authorization_denied');
  }
  const sql = getDatabase();
  let employeeAssignmentId: string | null = null;
  let sessionId: string | null = null;
  if (input.sessionId) {
    const sessions = await sql<
      { id: string; employee_assignment_id: string }[]
    >`
      select id, employee_assignment_id
      from allrice_chat_sessions
      where id = ${UuidSchema.parse(input.sessionId)}
        and organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId}
        and owner_id = ${ownerId}
        and archived_at is null
    `;
    const session = sessions[0];
    if (!session) throw new DataAccessError('authorization_denied');
    sessionId = session.id;
    employeeAssignmentId = session.employee_assignment_id;
  }
  const runAt = new Date(Date.now() + input.delayMinutes * 60_000);
  const schedule = AutomationScheduleSchema.parse({
    frequency: 'once',
    runAt: runAt.toISOString(),
    timezone: 'Asia/Shanghai',
  });
  const rows = await sql<AutomationRow[]>`
    insert into allrice_automations (
      organization_id, workspace_id, owner_id, name, description, prompt,
      trigger_type, schedule, status, conversation_mode,
      employee_assignment_id, session_id, next_run_at
    ) values (
      ${context.organizationId}, ${workspaceId}, ${ownerId},
      ${input.name.trim().slice(0, 160)}, '', ${input.prompt.trim()},
      'schedule', ${sql.json(schedule)}, 'enabled', 'reuse',
      ${employeeAssignmentId}, ${sessionId}, ${runAt}
    ) returning *, null::text as last_run_status,
      null::uuid as last_session_id
  `;
  const row = rows[0];
  if (!row) throw new Error('automation creation failed');
  await sql`
    insert into allrice_audit_events (
      organization_id, workspace_id, actor_id, action, resource_type,
      resource_id, decision, reason
    ) values (
      ${context.organizationId}, ${workspaceId}, ${ownerId},
      'automation.create', 'automation', ${row.id}, 'allowed', 'automation_tool'
    )
  `;
  return mapAutomation(row);
}

export async function updateAutomation(
  context: RequestContext,
  workspaceIdInput: string,
  automationId: string,
  input: unknown,
) {
  const workspaceId = await resolveWorkspaceId(context, workspaceIdInput);
  const current = await getAutomationRow(context, workspaceId, automationId);
  const parsed = UpdateAutomationInputSchema.parse(input);
  const schedule =
    parsed.schedule ?? AutomationScheduleSchema.parse(current.schedule);
  const status = parsed.status ?? current.status;
  const completedOneTimeTask =
    status === 'enabled' &&
    schedule.frequency === 'once' &&
    !parsed.schedule &&
    current.last_run_at !== null;
  const effectiveStatus = completedOneTimeTask ? 'paused' : status;
  const nextRunAt =
    effectiveStatus === 'enabled' &&
    (parsed.schedule || current.status === 'paused' || !current.next_run_at)
      ? nextScheduleAt(schedule)
      : effectiveStatus === 'paused'
        ? null
        : current.next_run_at;
  if (parsed.employeeAssignmentId) {
    const sql = getDatabase();
    const assignment = await sql<{ id: string }[]>`
      select id from allrice_employee_assignments
      where id = ${parsed.employeeAssignmentId}
        and organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId}
        and user_id = ${userId(context)} and active
    `;
    if (!assignment[0]) throw new DataAccessError('authorization_denied');
  }
  const sql = getDatabase();
  const rows = await sql<AutomationRow[]>`
    update allrice_automations
    set name = coalesce(${parsed.name ?? null}, name),
        description = coalesce(${parsed.description ?? null}, description),
        prompt = coalesce(${parsed.prompt ?? null}, prompt),
        schedule = ${sql.json(schedule)},
        status = ${effectiveStatus},
        conversation_mode = coalesce(${parsed.conversationMode ?? null}, conversation_mode),
        employee_assignment_id = ${parsed.employeeAssignmentId === undefined ? current.employee_assignment_id : parsed.employeeAssignmentId},
        next_run_at = ${nextRunAt},
        updated_at = now()
    where id = ${current.id}
    returning *, null::text as last_run_status,
      null::uuid as last_session_id
  `;
  const row = rows[0];
  if (!row) throw new Error('automation update failed');
  await audit(context, workspaceId, 'automation.update', row.id);
  return mapAutomation(row);
}

export async function deleteAutomation(
  context: RequestContext,
  workspaceIdInput: string,
  automationId: string,
) {
  const workspaceId = await resolveWorkspaceId(context, workspaceIdInput);
  const current = await getAutomationRow(context, workspaceId, automationId);
  const sql = getDatabase();
  await sql`delete from allrice_automations where id = ${current.id}`;
  await audit(context, workspaceId, 'automation.delete', current.id);
}

async function membershipsForOwner(
  organizationId: string,
  workspaceId: string,
  ownerId: string,
) {
  const sql = getDatabase();
  const rows = await sql<
    {
      id: string;
      user_id: string;
      organization_id: string;
      workspace_id: string | null;
      role: Membership['role'];
      active: boolean;
    }[]
  >`
    select id, user_id, organization_id, workspace_id, role, active
    from allrice_memberships
    where organization_id = ${organizationId}
      and user_id = ${ownerId} and active
  `;
  const memberships: Membership[] = rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    role: row.role,
    active: row.active,
  }));
  if (
    !memberships.some(
      (membership) =>
        membership.workspaceId === null ||
        membership.workspaceId === workspaceId,
    )
  ) {
    throw new DataAccessError('authorization_denied');
  }
  return memberships;
}

async function internalContext(input: {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
}) {
  const memberships = await membershipsForOwner(
    input.organizationId,
    input.workspaceId,
    input.ownerId,
  );
  return RequestContextSchema.parse({
    requestId: randomUUID(),
    sessionId: randomUUID(),
    actor: { type: 'user', id: input.ownerId },
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    memberships,
    authenticatedAt: new Date().toISOString(),
  });
}

function mapRunRow(row: AutomationRunRow) {
  return mapAutomationRun(row);
}

async function enqueueClaim(claim: AutomationClaim) {
  const automation = claim.automation;
  const context = await internalContext({
    organizationId: automation.organizationId,
    workspaceId: automation.workspaceId,
    ownerId: automation.ownerId,
  });
  const { createChatSession, sendChatMessage } =
    await import('../workspace/service.ts');
  let sessionId =
    automation.conversationMode === 'reuse'
      ? ((
          await getDatabase()<AutomationRow[]>`
            select * from allrice_automations where id = ${automation.id}
          `
        )[0]?.session_id ?? null)
      : null;
  if (!sessionId) {
    const session = await createChatSession(context, {
      workspaceId: automation.workspaceId,
      employeeAssignmentId: automation.employeeAssignmentId ?? undefined,
      title: `自动化 · ${automation.name} · ${new Date().toLocaleString(
        'zh-CN',
        {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        },
      )}`.slice(0, 160),
    });
    sessionId = session.id;
    if (automation.conversationMode === 'reuse') {
      await getDatabase()`
        update allrice_automations set session_id = ${sessionId}, updated_at = now()
        where id = ${automation.id} and session_id is null
      `;
    }
  }
  const result = await sendChatMessage(
    context,
    automation.workspaceId,
    sessionId,
    {
      clientMessageId: randomUUID(),
      text: `${automation.prompt}\n\n这是由自动化任务「${automation.name}」触发的执行。请直接完成任务并给出可交付结果。`,
      attachmentIds: [],
    },
  );
  const sql = getDatabase();
  const rows = await sql<AutomationRunRow[]>`
    update allrice_automation_runs
    set run_id = ${result.run.id}, session_id = ${sessionId}, status = 'queued'
    where id = ${claim.automationRun.id}
    returning *
  `;
  const row = rows[0];
  if (!row) throw new Error('automation run update failed');
  return mapRunRow(row);
}

async function markClaimFailed(claim: AutomationClaim, error: unknown) {
  const sql = getDatabase();
  await sql`
    update allrice_automation_runs
    set status = 'failed', error_code = 'AUTOMATION_ENQUEUE_FAILED',
        error_message = ${error instanceof Error ? error.message : 'automation enqueue failed'},
        completed_at = now()
    where id = ${claim.automationRun.id}
  `;
}

async function makeClaim(
  row: AutomationRow,
  automationRunRow: AutomationRunRow,
): Promise<AutomationClaim> {
  return {
    automation: mapAutomation(row),
    automationRun: mapAutomationRun(automationRunRow),
  };
}

export async function claimDueAutomations(limit = 10) {
  const sql = getDatabase();
  const due = await sql<AutomationRow[]>`
    select a.*, latest.status as last_run_status,
      latest.session_id as last_session_id
    from allrice_automations a
    left join lateral (
      select r.status, r.session_id from allrice_automation_runs r
      where r.automation_id = a.id order by r.created_at desc limit 1
    ) latest on true
    where a.status = 'enabled' and a.next_run_at is not null and a.next_run_at <= now()
    order by a.next_run_at, a.id
    limit ${limit}
  `;
  const claims: AutomationClaim[] = [];
  for (const candidate of due) {
    const claim = await sql.begin(async (transaction) => {
      const locked = await transaction<AutomationRow[]>`
        select a.*, latest.status as last_run_status,
          latest.session_id as last_session_id
        from allrice_automations a
        left join lateral (
          select r.status, r.session_id from allrice_automation_runs r
          where r.automation_id = a.id order by r.created_at desc limit 1
        ) latest on true
        where a.id = ${candidate.id} and a.status = 'enabled'
        for update of a
      `;
      const row = locked[0];
      if (!row || !row.next_run_at || row.next_run_at > new Date()) return null;
      const scheduledFor = row.next_run_at;
      const schedule = AutomationScheduleSchema.parse(row.schedule);
      const isOneTime = schedule.frequency === 'once';
      const nextRunAt = isOneTime
        ? null
        : nextScheduleAt(schedule, scheduledFor);
      const runs = await transaction<AutomationRunRow[]>`
        insert into allrice_automation_runs (
          organization_id, workspace_id, automation_id, scheduled_for
        ) values (
          ${row.organization_id}, ${row.workspace_id}, ${row.id}, ${scheduledFor}
        ) on conflict (automation_id, scheduled_for) do nothing
        returning *
      `;
      if (!runs[0]) {
        await transaction`
          update allrice_automations
          set next_run_at = ${isOneTime ? null : nextScheduleAt(schedule, scheduledFor)},
              status = ${isOneTime ? 'paused' : 'enabled'},
              updated_at = now()
          where id = ${row.id}
        `;
        return null;
      }
      await transaction`
        update allrice_automations
        set next_run_at = ${nextRunAt},
            status = ${isOneTime ? 'paused' : 'enabled'},
            last_run_at = now(), updated_at = now()
        where id = ${row.id}
      `;
      return await makeClaim(row, runs[0]);
    });
    if (claim) claims.push(claim);
  }
  for (const claim of claims) {
    try {
      await enqueueClaim(claim);
    } catch (error) {
      await markClaimFailed(claim, error);
    }
  }
  return claims.length;
}

export async function runAutomationNow(
  context: RequestContext,
  workspaceIdInput: string,
  automationId: string,
) {
  const workspaceId = await resolveWorkspaceId(context, workspaceIdInput);
  const row = await getAutomationRow(context, workspaceId, automationId);
  const sql = getDatabase();
  const runs = await sql<AutomationRunRow[]>`
    insert into allrice_automation_runs (
      organization_id, workspace_id, automation_id, scheduled_for
    ) values (
      ${row.organization_id}, ${row.workspace_id}, ${row.id}, now()
    ) returning *
  `;
  if (!runs[0]) throw new Error('manual automation run creation failed');
  const claim = await makeClaim(row, runs[0]);
  try {
    const run = await enqueueClaim(claim);
    await audit(context, workspaceId, 'automation.run', row.id);
    return run;
  } catch (error) {
    await markClaimFailed(claim, error);
    throw error;
  }
}

export async function syncAutomationRuns() {
  const sql = getDatabase();
  await sql`
    update allrice_automation_runs ar
    set status = case
          when r.state in ('queued', 'running', 'succeeded', 'failed', 'canceled')
            then r.state
          else 'running'
        end,
        started_at = coalesce(ar.started_at, r.started_at),
        completed_at = coalesce(ar.completed_at, r.completed_at),
        error_code = r.error_code,
        error_message = r.error_message
    from allrice_runs r
    where ar.run_id = r.id
      and ar.status <> case
        when r.state in ('queued', 'running', 'succeeded', 'failed', 'canceled')
          then r.state
        else 'running'
      end
  `;
  return 0;
}
