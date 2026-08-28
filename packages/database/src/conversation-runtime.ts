import { UuidSchema } from '@allrice/contracts';
import type postgres from 'postgres';
import { z } from 'zod';

import { getDatabase } from './index.ts';
import {
  conversationUsageWatermark,
  effectiveContextTokens,
} from './conversation-usage.ts';

const ChecksumSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ThreadIdSchema = z.string().trim().min(1).max(255);
const TurnIdSchema = z.string().trim().min(1).max(255);

type ConversationRuntimeState = 'idle' | 'running' | 'interrupted' | 'error';

interface ConversationRuntimeRow {
  organization_id: string;
  workspace_id: string;
  session_id: string;
  owner_id: string;
  thread_id: string | null;
  thread_generation: number;
  config_checksum: string;
  state: ConversationRuntimeState;
  active_run_id: string | null;
  active_turn_id: string | null;
  worker_id: string | null;
  last_error_code: string | null;
  usage_baseline_input_tokens: number | null;
  last_input_tokens: number | null;
  last_cached_input_tokens: number | null;
  dynamic_context_tokens: number;
  compact_threshold_tokens: number;
  context_pressure_tokens: number;
}

interface DshRuntimeInventoryRow extends ConversationRuntimeRow {
  organization_slug: string;
  organization_name: string;
  workspace_slug: string;
  workspace_name: string;
  session_title: string;
  owner_email: string;
  employee_name: string | null;
  provider_snapshot: unknown;
  last_started_at: Date | string | null;
  last_completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  process_id: string | null;
  process_status: 'live' | 'offline' | null;
  process_worker_id: string | null;
  process_provider_route: string | null;
  process_model: string | null;
  process_reasoning_effort: string | null;
  process_native_tools: unknown;
  process_started_at: Date | string | null;
  process_last_activity_at: Date | string | null;
  process_last_seen_at: Date | string | null;
}

interface DshRuntimeEventRow {
  run_id: string;
  run_state: string;
  sequence: number;
  event_type: string;
  payload: unknown;
  occurred_at: Date | string;
}

const runtimeEventKinds = new Set([
  'context',
  'think',
  'search',
  'tool',
  'todo',
  'compaction',
  'lifecycle',
]);

function safeText(value: unknown, maximum = 4_000) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, maximum)
    : null;
}

function safeRecord(value: unknown) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mapDshRuntimeEvent(row: DshRuntimeEventRow) {
  const payload = safeRecord(row.payload);
  if (payload.source !== 'dsh' && payload.source !== 'tool_broker') return null;
  if (row.event_type === 'harness.native') {
    const presentation = safeText(payload.presentation, 40);
    if (!presentation || !runtimeEventKinds.has(presentation)) return null;
    const native = safeRecord(payload.nativePayload);
    const callId = safeText(native.callId, 160);
    const key =
      (presentation === 'tool' || presentation === 'search') && callId
        ? `tool:${callId}`
        : presentation === 'think'
          ? `think:${String(native.turn ?? '')}:${String(native.step ?? '')}:${String(safeRecord(native.chunk).index ?? '')}`
          : `${row.run_id}:${row.sequence}`;
    return {
      id: `${row.run_id}:${row.sequence}`,
      key,
      runId: row.run_id,
      sequence: row.sequence,
      kind: presentation,
      status: safeText(payload.status, 40) ?? 'info',
      title: safeText(payload.label, 240) ?? 'DSH Event',
      detail: safeText(payload.summary, 1_000),
      occurredAt: timestamp(row.occurred_at),
    };
  }
  if (row.event_type.startsWith('tool.')) {
    const native = safeRecord(payload.nativePayload);
    const name = safeText(payload.name, 160) ?? 'Tool';
    const toolCallId = safeText(payload.toolCallId, 160);
    const search = native.presentation === 'search' || name === 'web.search';
    const query = search ? safeText(native.query, 500) : null;
    return {
      id: `${row.run_id}:${row.sequence}`,
      key: toolCallId ? `tool:${toolCallId}` : `${row.run_id}:${row.sequence}`,
      runId: row.run_id,
      sequence: row.sequence,
      kind: search ? 'search' : 'tool',
      status: row.event_type.endsWith('.started')
        ? 'started'
        : row.event_type.endsWith('.failed')
          ? 'failed'
          : 'completed',
      title: search ? (query ? `Search · ${query}` : 'Search') : name,
      detail: safeText(payload.summary, 1_000),
      occurredAt: timestamp(row.occurred_at),
    };
  }
  if (row.event_type === 'assistant.text.completed') {
    return {
      id: `${row.run_id}:${row.sequence}`,
      key: `${row.run_id}:answer`,
      runId: row.run_id,
      sequence: row.sequence,
      kind: 'answer',
      status: 'completed',
      title: 'Answer',
      detail: safeText(payload.text),
      occurredAt: timestamp(row.occurred_at),
    };
  }
  return null;
}

export class ConversationRuntimeError extends Error {
  constructor(
    public readonly code:
      | 'conversation_busy'
      | 'conversation_ownership_lost'
      | 'conversation_not_found',
  ) {
    super(code);
  }
}

export function conversationRuntimeCanAcquire(input: {
  state: ConversationRuntimeState;
  activeRunId: string | null;
  requestedRunId: string;
  activeRunTerminal: boolean;
}) {
  return (
    input.state !== 'running' ||
    input.activeRunId === input.requestedRunId ||
    input.activeRunTerminal
  );
}

function mapBinding(row: ConversationRuntimeRow) {
  return {
    sessionId: row.session_id,
    threadId: row.thread_id,
    generation: row.thread_generation,
    configChecksum: row.config_checksum,
    state: row.state,
    activeRunId: row.active_run_id,
    activeTurnId: row.active_turn_id,
    workerId: row.worker_id,
    lastErrorCode: row.last_error_code,
    usageBaselineInputTokens: row.usage_baseline_input_tokens,
    lastInputTokens: row.last_input_tokens,
    lastCachedInputTokens: row.last_cached_input_tokens,
    dynamicContextTokens: row.dynamic_context_tokens,
    compactThresholdTokens: row.compact_threshold_tokens,
    contextPressureTokens: row.context_pressure_tokens,
  };
}

function timestamp(value: Date | string | null) {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Platform-only, redacted inventory for the Runtime Console. This deliberately
 * exposes durable runtime identity and lifecycle facts, never prompts,
 * credentials, tool arguments, host paths or raw provider configuration.
 */
export async function listDshRuntimeInventory(limit = 100) {
  const safeLimit = z.number().int().min(1).max(500).parse(limit);
  const sql = getDatabase();
  const rows = await sql<DshRuntimeInventoryRow[]>`
    select runtime.*, organization.slug as organization_slug,
      organization.name as organization_name,
      workspace.slug as workspace_slug, workspace.name as workspace_name,
      session.title as session_title, owner.email as owner_email,
      employee.name as employee_name,
      latest_run.provider_snapshot,
      runtime_process.id as process_id,
      runtime_process.process_status,
      runtime_process.worker_id as process_worker_id,
      runtime_process.provider_route as process_provider_route,
      runtime_process.model as process_model,
      runtime_process.reasoning_effort as process_reasoning_effort,
      runtime_process.native_tools as process_native_tools,
      runtime_process.started_at as process_started_at,
      runtime_process.last_activity_at as process_last_activity_at,
      runtime_process.last_seen_at as process_last_seen_at
    from allrice_conversation_runtimes runtime
    join allrice_organizations organization
      on organization.id = runtime.organization_id
    join allrice_workspaces workspace
      on workspace.id = runtime.workspace_id
      and workspace.organization_id = runtime.organization_id
    join allrice_chat_sessions session
      on session.id = runtime.session_id
      and session.organization_id = runtime.organization_id
      and session.workspace_id = runtime.workspace_id
    join allrice_users owner on owner.id = runtime.owner_id
    left join lateral (
      select employee_run.employee_version_id, employee_run.provider_snapshot
      from allrice_employee_runs employee_run
      where employee_run.organization_id = runtime.organization_id
        and employee_run.workspace_id = runtime.workspace_id
        and employee_run.session_id = runtime.session_id
      order by employee_run.created_at desc
      limit 1
    ) latest_run on true
    left join allrice_employee_versions employee_version
      on employee_version.id = latest_run.employee_version_id
      and employee_version.organization_id = runtime.organization_id
      and employee_version.workspace_id = runtime.workspace_id
    left join allrice_employees employee
      on employee.id = employee_version.employee_id
      and employee.organization_id = runtime.organization_id
      and employee.workspace_id = runtime.workspace_id
    left join lateral (
      select process.*,
        case
          when process.status = 'live'
            and process.last_seen_at >= now() - interval '15 seconds'
          then 'live'
          else 'offline'
        end as process_status
      from allrice_dsh_runtime_instances process
      where process.organization_id = runtime.organization_id
        and process.workspace_id = runtime.workspace_id
        and process.session_id = runtime.session_id
      order by process.last_seen_at desc
      limit 1
    ) runtime_process on true
    order by
      case runtime.state when 'running' then 0 when 'error' then 1 else 2 end,
      runtime.updated_at desc
    limit ${safeLimit}
  `;
  return rows.map((row) => {
    const provider = z
      .object({
        provider: z.string().optional(),
        route: z.string().optional(),
        model: z.string().optional(),
        reasoningEffort: z.string().optional(),
      })
      .passthrough()
      .safeParse(row.provider_snapshot);
    return {
      organization: {
        id: row.organization_id,
        slug: row.organization_slug,
        name: row.organization_name,
      },
      workspace: {
        id: row.workspace_id,
        slug: row.workspace_slug,
        name: row.workspace_name,
      },
      owner: { id: row.owner_id, email: row.owner_email },
      session: {
        id: row.session_id,
        title: row.session_title,
        employeeName: row.employee_name,
      },
      runtime: {
        harness: 'dsh' as const,
        state: row.state,
        threadId: row.thread_id,
        generation: row.thread_generation,
        activeRunId: row.active_run_id,
        activeTurnId: row.active_turn_id,
        workerId: row.worker_id,
        configFingerprint: row.config_checksum.slice(0, 19),
        lastErrorCode: row.last_error_code,
        contextPressureTokens: row.context_pressure_tokens,
        compactThresholdTokens: row.compact_threshold_tokens,
        lastStartedAt: timestamp(row.last_started_at),
        lastCompletedAt: timestamp(row.last_completed_at),
        createdAt: timestamp(row.created_at),
        updatedAt: timestamp(row.updated_at),
      },
      provider: provider.success
        ? {
            provider: provider.data.provider ?? 'dsh',
            route: provider.data.route ?? 'unknown',
            model: provider.data.model ?? 'unknown',
            reasoningEffort: provider.data.reasoningEffort ?? 'unknown',
          }
        : null,
      process: row.process_id
        ? {
            id: row.process_id,
            status: row.process_status ?? 'offline',
            workerId: row.process_worker_id,
            providerRoute: row.process_provider_route,
            model: row.process_model,
            reasoningEffort: row.process_reasoning_effort,
            nativeTools: z.array(z.string()).safeParse(row.process_native_tools)
              .success
              ? (row.process_native_tools as string[])
              : [],
            startedAt: timestamp(row.process_started_at),
            lastActivityAt: timestamp(row.process_last_activity_at),
            lastSeenAt: timestamp(row.process_last_seen_at),
          }
        : null,
    };
  });
}

/**
 * Platform-only DSH event mirror for one Session. Only presentation-safe fields
 * survive this projection; prompts, tool arguments, credentials, host paths and
 * hidden chain-of-thought are never returned.
 */
export async function listDshRuntimeEventTimeline(sessionIdInput: string) {
  const sessionId = UuidSchema.parse(sessionIdInput);
  const sql = getDatabase();
  const rows = await sql<DshRuntimeEventRow[]>`
    with latest_run as (
      select employee_run.run_id
      from allrice_employee_runs employee_run
      where employee_run.session_id = ${sessionId}
      order by employee_run.created_at desc
      limit 1
    )
    select event.run_id, run.state as run_state, event.sequence,
      event.event_type, event.payload, event.occurred_at
    from latest_run
    join allrice_runs run on run.id = latest_run.run_id
    join allrice_run_events event on event.run_id = latest_run.run_id
    order by event.sequence
  `;
  const first = rows[0];
  return {
    sessionId,
    run: first ? { id: first.run_id, status: first.run_state } : null,
    events: rows
      .map(mapDshRuntimeEvent)
      .filter((event): event is NonNullable<typeof event> => event !== null),
  };
}

export async function acquireConversationRuntime(input: {
  organizationId: string;
  workspaceId: string;
  sessionId: string;
  ownerId: string;
  runId: string;
  workerId: string;
  configChecksum: string;
  compactThresholdTokens: number;
}) {
  const values = {
    organizationId: UuidSchema.parse(input.organizationId),
    workspaceId: UuidSchema.parse(input.workspaceId),
    sessionId: UuidSchema.parse(input.sessionId),
    ownerId: UuidSchema.parse(input.ownerId),
    runId: UuidSchema.parse(input.runId),
    workerId: UuidSchema.parse(input.workerId),
    configChecksum: ChecksumSchema.parse(input.configChecksum),
    compactThresholdTokens: z
      .number()
      .int()
      .min(1_000)
      .max(1_000_000)
      .parse(input.compactThresholdTokens),
  };
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    await transaction`
      insert into allrice_conversation_runtimes (
        organization_id, workspace_id, session_id, owner_id, config_checksum,
        compact_threshold_tokens
      ) values (
        ${values.organizationId}, ${values.workspaceId}, ${values.sessionId},
        ${values.ownerId}, ${values.configChecksum},
        ${values.compactThresholdTokens}
      ) on conflict (session_id) do nothing
    `;
    const rows = await transaction<ConversationRuntimeRow[]>`
      select * from allrice_conversation_runtimes
      where organization_id = ${values.organizationId}
        and workspace_id = ${values.workspaceId}
        and session_id = ${values.sessionId}
        and owner_id = ${values.ownerId}
      for update
    `;
    const current = rows[0];
    if (!current) throw new ConversationRuntimeError('conversation_not_found');
    const activeRuns = current.active_run_id
      ? await transaction<{ state: string }[]>`
          select state from allrice_runs
          where id = ${current.active_run_id}
            and organization_id = ${values.organizationId}
            and workspace_id = ${values.workspaceId}
        `
      : [];
    const activeRunTerminal =
      !activeRuns[0] ||
      ['succeeded', 'failed', 'canceled'].includes(activeRuns[0].state);
    if (
      !conversationRuntimeCanAcquire({
        state: current.state,
        activeRunId: current.active_run_id,
        requestedRunId: values.runId,
        activeRunTerminal,
      })
    ) {
      throw new ConversationRuntimeError('conversation_busy');
    }
    const configChanged = current.config_checksum !== values.configChecksum;
    const updated = await transaction<ConversationRuntimeRow[]>`
      update allrice_conversation_runtimes
      set state = 'running', active_run_id = ${values.runId},
          active_turn_id = null, worker_id = ${values.workerId},
          config_checksum = ${values.configChecksum},
          thread_id = ${configChanged ? null : current.thread_id},
          usage_baseline_input_tokens = ${configChanged ? null : current.usage_baseline_input_tokens},
          last_input_tokens = ${configChanged ? null : current.last_input_tokens},
          last_cached_input_tokens = ${configChanged ? null : current.last_cached_input_tokens},
          dynamic_context_tokens = ${configChanged ? 0 : current.dynamic_context_tokens},
          compact_threshold_tokens = ${values.compactThresholdTokens},
          context_pressure_tokens = ${configChanged ? 0 : current.context_pressure_tokens},
          last_error_code = null, last_started_at = now(), updated_at = now()
      where session_id = ${values.sessionId}
      returning *
    `;
    await transaction`
      update allrice_conversation_followups
      set state = 'running'
      where run_id = ${values.runId} and state = 'released'
    `;
    return mapBinding(updated[0]!);
  });
}

async function lockedOwnedRuntime(
  transaction: postgres.TransactionSql,
  input: {
    organizationId: string;
    workspaceId: string;
    sessionId: string;
    runId: string;
    workerId: string;
  },
) {
  const rows = await transaction<ConversationRuntimeRow[]>`
    select * from allrice_conversation_runtimes
    where organization_id = ${input.organizationId}
      and workspace_id = ${input.workspaceId}
      and session_id = ${input.sessionId}
    for update
  `;
  const row = rows[0];
  if (
    !row ||
    row.state !== 'running' ||
    row.active_run_id !== input.runId ||
    row.worker_id !== input.workerId
  ) {
    throw new ConversationRuntimeError('conversation_ownership_lost');
  }
  return row;
}

function ownedValues(input: {
  organizationId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  workerId: string;
}) {
  return {
    organizationId: UuidSchema.parse(input.organizationId),
    workspaceId: UuidSchema.parse(input.workspaceId),
    sessionId: UuidSchema.parse(input.sessionId),
    runId: UuidSchema.parse(input.runId),
    workerId: UuidSchema.parse(input.workerId),
  };
}

export async function bindConversationThread(input: {
  organizationId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  workerId: string;
  threadId: string;
}) {
  const values = {
    ...ownedValues(input),
    threadId: ThreadIdSchema.parse(input.threadId),
  };
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const current = await lockedOwnedRuntime(transaction, values);
    const changed = current.thread_id !== values.threadId;
    const rows = await transaction<ConversationRuntimeRow[]>`
      update allrice_conversation_runtimes
      set thread_id = ${values.threadId},
          thread_generation = thread_generation + ${changed ? 1 : 0},
          usage_baseline_input_tokens = ${changed ? null : current.usage_baseline_input_tokens},
          last_input_tokens = ${changed ? null : current.last_input_tokens},
          last_cached_input_tokens = ${changed ? null : current.last_cached_input_tokens},
          dynamic_context_tokens = ${changed ? 0 : current.dynamic_context_tokens},
          context_pressure_tokens = ${changed ? 0 : current.context_pressure_tokens},
          active_turn_id = null, updated_at = now()
      where session_id = ${values.sessionId}
      returning *
    `;
    return mapBinding(rows[0]!);
  });
}

export async function recordConversationUsage(input: {
  organizationId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  workerId: string;
  generation: number;
  inputTokens: number;
  cachedInputTokens: number;
  applicationEstimatedTokens: number;
}) {
  const values = {
    ...ownedValues(input),
    generation: z.number().int().nonnegative().parse(input.generation),
    inputTokens: z.number().int().nonnegative().parse(input.inputTokens),
    cachedInputTokens: z
      .number()
      .int()
      .nonnegative()
      .parse(input.cachedInputTokens),
    applicationEstimatedTokens: z
      .number()
      .int()
      .nonnegative()
      .parse(input.applicationEstimatedTokens),
  };
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const current = await lockedOwnedRuntime(transaction, values);
    if (current.thread_generation !== values.generation) {
      throw new ConversationRuntimeError('conversation_ownership_lost');
    }
    const watermark = conversationUsageWatermark({
      baselineInputTokens: current.usage_baseline_input_tokens,
      inputTokens: values.inputTokens,
    });
    const contextPressureTokens = effectiveContextTokens({
      applicationEstimatedTokens: values.applicationEstimatedTokens,
      observedDynamicTokens: watermark.dynamicContextTokens,
    });
    const rows = await transaction<ConversationRuntimeRow[]>`
      update allrice_conversation_runtimes
      set usage_baseline_input_tokens = ${watermark.baselineInputTokens},
          last_input_tokens = ${watermark.inputTokens},
          last_cached_input_tokens = ${values.cachedInputTokens},
          dynamic_context_tokens = ${watermark.dynamicContextTokens},
          context_pressure_tokens = ${contextPressureTokens},
          updated_at = now()
      where session_id = ${values.sessionId}
      returning *
    `;
    return mapBinding(rows[0]!);
  });
}

export async function recordConversationTurn(input: {
  organizationId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  workerId: string;
  threadId: string;
  turnId: string;
}) {
  const values = {
    ...ownedValues(input),
    threadId: ThreadIdSchema.parse(input.threadId),
    turnId: TurnIdSchema.parse(input.turnId),
  };
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const current = await lockedOwnedRuntime(transaction, values);
    if (current.thread_id !== values.threadId) {
      throw new ConversationRuntimeError('conversation_ownership_lost');
    }
    const rows = await transaction<ConversationRuntimeRow[]>`
      update allrice_conversation_runtimes
      set active_turn_id = ${values.turnId}, updated_at = now()
      where session_id = ${values.sessionId}
      returning *
    `;
    return mapBinding(rows[0]!);
  });
}

export async function clearConversationTurn(input: {
  organizationId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  workerId: string;
}) {
  const values = ownedValues(input);
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    await lockedOwnedRuntime(transaction, values);
    const rows = await transaction<ConversationRuntimeRow[]>`
      update allrice_conversation_runtimes
      set active_turn_id = null, updated_at = now()
      where session_id = ${values.sessionId}
      returning *
    `;
    return mapBinding(rows[0]!);
  });
}

export async function releaseConversationRuntime(input: {
  organizationId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  workerId: string;
  outcome: 'idle' | 'interrupted' | 'error';
  errorCode?: string;
}) {
  const values = ownedValues(input);
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    await lockedOwnedRuntime(transaction, values);
    const rows = await transaction<ConversationRuntimeRow[]>`
      update allrice_conversation_runtimes
      set state = ${input.outcome}, active_run_id = null,
          active_turn_id = null, worker_id = null,
          last_error_code = ${input.errorCode ?? null},
          last_completed_at = now(), updated_at = now()
      where session_id = ${values.sessionId}
      returning *
    `;
    await transaction`
      update allrice_conversation_commands
      set state = 'rejected', error_code = 'TURN_CLOSED', updated_at = now()
      where organization_id = ${values.organizationId}
        and workspace_id = ${values.workspaceId}
        and session_id = ${values.sessionId}
        and state in ('pending', 'claimed')
    `;
    const next = await transaction<{ run_id: string }[]>`
      select run_id from allrice_conversation_followups
      where organization_id = ${values.organizationId}
        and workspace_id = ${values.workspaceId}
        and session_id = ${values.sessionId}
        and state = 'queued'
      order by created_at, run_id
      for update skip locked
      limit 1
    `;
    if (next[0]) {
      await transaction`
        update allrice_conversation_followups
        set state = 'released', released_at = now()
        where run_id = ${next[0].run_id}
      `;
      await transaction`
        update allrice_jobs
        set available_at = now(), timeout_at = now() + interval '5 minutes',
            updated_at = now()
        where run_id = ${next[0].run_id} and status = 'queued'
      `;
    }
    return mapBinding(rows[0]!);
  });
}
