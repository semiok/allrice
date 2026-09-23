import {
  UuidSchema,
  type RuntimeRunUsage,
  type TaskRuntimeTiming,
} from '@allrice/contracts';
import { readTaskClocks } from '../task-clock.ts';
import type postgres from 'postgres';
import { z } from 'zod';
import { cancelUnadoptedSteers } from './conversation-input.ts';

import { getDatabase } from '../core/client.ts';
import {
  conversationUsageWatermark,
  effectiveContextTokens,
} from '../conversation/usage.ts';

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
  dsh_context_as_of_seq: number | null;
  dsh_context_pressure_tokens: number | null;
  dsh_context_projected_tokens: number | null;
  dsh_context_window_tokens: number | null;
  dsh_context_observed_at: Date | string | null;
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

interface TenantRuntimeInventoryRow {
  organization_id: string;
  organization_slug: string;
  organization_name: string;
  workspace_id: string;
  workspace_slug: string;
  workspace_name: string;
  session_count: number;
  runtime_count: number;
  active_runtime_count: number;
  error_runtime_count: number;
  last_runtime_at: Date | string | null;
  bridge_device_id: string | null;
  bridge_name: string | null;
  bridge_platform: string | null;
  bridge_protocol_version: number | null;
  bridge_capabilities: string[] | null;
  bridge_last_seen_at: Date | string | null;
  bridge_workspace_label: string | null;
}

interface DshRuntimeEventRow {
  run_id: string;
  run_state: string;
  run_created_at: Date | string;
  run_completed_at: Date | string | null;
  user_content: unknown;
  user_created_at: Date | string;
  assistant_content: unknown;
  assistant_status: string;
  assistant_created_at: Date | string;
  assistant_completed_at: Date | string | null;
  sequence: number | null;
  event_type: string | null;
  payload: unknown;
  occurred_at: Date | string | null;
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
  if (row.sequence === null || row.event_type === null) return null;
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
    dshContextAsOfSeq: row.dsh_context_as_of_seq,
    dshContextPressureTokens: row.dsh_context_pressure_tokens,
    dshContextProjectedTokens: row.dsh_context_projected_tokens,
    dshContextWindowTokens: row.dsh_context_window_tokens,
    dshContextObservedAt: timestamp(row.dsh_context_observed_at),
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
    where session.archived_at is null
    order by
      case
        when runtime_process.process_status = 'live' then 0
        when runtime.state = 'running' then 1
        else 2
      end,
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
 * Platform-only tenant overview for the Runtime Console. A tenant entry is an
 * active workspace, including workspaces that have not created a Session yet.
 * Bridge presence is resolved by tenant scope and never by AI employee.
 */
export async function listTenantRuntimeInventory() {
  const sql = getDatabase();
  const rows = await sql<TenantRuntimeInventoryRow[]>`
    select organization.id as organization_id,
      organization.slug as organization_slug,
      organization.name as organization_name,
      workspace.id as workspace_id,
      workspace.slug as workspace_slug,
      workspace.name as workspace_name,
      coalesce(session_stats.session_count, 0)::integer as session_count,
      coalesce(runtime_stats.runtime_count, 0)::integer as runtime_count,
      coalesce(runtime_stats.active_runtime_count, 0)::integer
        as active_runtime_count,
      coalesce(runtime_stats.error_runtime_count, 0)::integer
        as error_runtime_count,
      runtime_stats.last_runtime_at,
      bridge.id as bridge_device_id,
      bridge.name as bridge_name,
      bridge.platform as bridge_platform,
      bridge.protocol_version as bridge_protocol_version,
      bridge.capabilities as bridge_capabilities,
      bridge.last_seen_at as bridge_last_seen_at,
      bridge.workspace_label as bridge_workspace_label
    from allrice_workspaces workspace
    join allrice_organizations organization
      on organization.id = workspace.organization_id
    left join lateral (
      select count(*)::integer as session_count
      from allrice_chat_sessions session
      where session.organization_id = workspace.organization_id
        and session.workspace_id = workspace.id
        and session.archived_at is null
    ) session_stats on true
    left join lateral (
      select count(*)::integer as runtime_count,
        count(*) filter (
          where latest_process.status = 'live'
            and latest_process.last_seen_at >= now() - interval '15 seconds'
        )::integer as active_runtime_count,
        count(*) filter (where runtime.state = 'error')::integer
          as error_runtime_count,
        max(runtime.updated_at) as last_runtime_at
      from allrice_conversation_runtimes runtime
      join allrice_chat_sessions runtime_session
        on runtime_session.id = runtime.session_id
        and runtime_session.organization_id = runtime.organization_id
        and runtime_session.workspace_id = runtime.workspace_id
        and runtime_session.archived_at is null
      left join lateral (
        select process.status, process.last_seen_at
        from allrice_dsh_runtime_instances process
        where process.organization_id = runtime.organization_id
          and process.workspace_id = runtime.workspace_id
          and process.session_id = runtime.session_id
        order by process.last_seen_at desc
        limit 1
      ) latest_process on true
      where runtime.organization_id = workspace.organization_id
        and runtime.workspace_id = workspace.id
    ) runtime_stats on true
    left join lateral (
      select device.id, device.name, device.platform,
        device.protocol_version, device.capabilities, device.last_seen_at,
        folder.label as workspace_label
      from allrice_bridge_devices device
      left join lateral (
        select folder_grant.label
        from allrice_bridge_folder_grants folder_grant
        where folder_grant.device_id = device.id
          and folder_grant.revoked_at is null
        order by folder_grant.created_at desc, folder_grant.id desc
        limit 1
      ) folder on true
      where device.organization_id = workspace.organization_id
        and device.workspace_id = workspace.id
        and device.revoked_at is null
      order by device.last_seen_at desc nulls last, device.created_at desc
      limit 1
    ) bridge on true
    where workspace.archived_at is null
      and organization.archived_at is null
      and organization.slug <> 'allrice-platform'
    order by organization.name, workspace.name, workspace.id
  `;
  return rows.map((row) => ({
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
    sessions: {
      total: row.session_count,
      runtimeBound: row.runtime_count,
      active: row.active_runtime_count,
      error: row.error_runtime_count,
      lastRuntimeAt: timestamp(row.last_runtime_at),
    },
    bridge: row.bridge_device_id
      ? {
          deviceId: row.bridge_device_id,
          name: row.bridge_name ?? 'Rice Bridge',
          platform: row.bridge_platform ?? 'unknown',
          protocolVersion: row.bridge_protocol_version,
          capabilities: row.bridge_capabilities ?? [],
          status:
            row.bridge_last_seen_at &&
            new Date(row.bridge_last_seen_at).getTime() >= Date.now() - 45_000
              ? ('online' as const)
              : ('offline' as const),
          lastSeenAt: timestamp(row.bridge_last_seen_at),
          workspaceLabel: row.bridge_workspace_label,
        }
      : null,
  }));
}

/**
 * Platform-only DSH event mirror for one Session. Only presentation-safe fields
 * survive this projection; prompts, tool arguments, credentials, host paths and
 * hidden chain-of-thought are never returned.
 */
export async function listDshRuntimeEventTimeline(
  sessionIdInput: string,
  options: { runId?: string; database?: ReturnType<typeof getDatabase> } = {},
) {
  const sessionId = UuidSchema.parse(sessionIdInput);
  const sql = options.database ?? getDatabase(),
    selectedRun = options.runId ? UuidSchema.parse(options.runId) : null;
  const rows = await sql<DshRuntimeEventRow[]>`
    select employee_run.run_id, run.state as run_state,
      employee_run.created_at as run_created_at,
      employee_run.completed_at as run_completed_at,
      user_message.content as user_content,
      user_message.created_at as user_created_at,
      assistant_message.content as assistant_content,
      assistant_message.status as assistant_status,
      assistant_message.created_at as assistant_created_at,
      assistant_message.completed_at as assistant_completed_at,
      event.sequence, event.event_type, event.payload, event.occurred_at
    from allrice_employee_runs employee_run
    join allrice_runs run
      on run.id = employee_run.run_id
      and run.organization_id = employee_run.organization_id
      and run.workspace_id = employee_run.workspace_id
    join allrice_messages user_message
      on user_message.id = employee_run.user_message_id
      and user_message.organization_id = employee_run.organization_id
      and user_message.workspace_id = employee_run.workspace_id
    join allrice_messages assistant_message
      on assistant_message.id = employee_run.assistant_message_id
      and assistant_message.organization_id = employee_run.organization_id
      and assistant_message.workspace_id = employee_run.workspace_id
    left join lateral (
      select event.* from allrice_run_events event
      where event.run_id = employee_run.run_id
        and event.organization_id = employee_run.organization_id
        and event.workspace_id = employee_run.workspace_id
      order by event.sequence desc limit ${selectedRun ? 150 : null}::int
    ) event on true
    where employee_run.session_id = ${sessionId}
      and (${selectedRun}::uuid is null or employee_run.run_id=${selectedRun}::uuid)
    order by employee_run.created_at, event.sequence nulls first
  `;
  // Aggregate once per route receipt, independently of the many timeline events.
  // Include all attempts, but never sum child ledgers into an already settled
  // root receipt. Scope each join to the same organization/workspace/Run.
  const usageRows = await sql<
    {
      run_id: string;
      attempts: number;
      receipts: number;
      input_tokens: string | null;
      output_tokens: string | null;
      cached_input_tokens: string | null;
      usage_complete: boolean;
      cache_usage_known: boolean;
    }[]
  >`
    select er.run_id, count(d.id)::int as attempts, count(l.id)::int as receipts,
      sum(l.input_tokens)::bigint as input_tokens,
      sum(l.output_tokens)::bigint as output_tokens,
      sum(l.cached_input_tokens)::bigint as cached_input_tokens,
      bool_and(l.id is not null and l.usage_complete) as usage_complete,
      bool_and(l.id is not null and l.cache_usage_known) as cache_usage_known
    from allrice_employee_runs er
    left join allrice_route_decisions d on d.run_id=er.run_id
      and d.organization_id=er.organization_id and d.workspace_id=er.workspace_id
    left join allrice_model_usage_ledger l on l.route_decision_id=d.id
      and l.organization_id=er.organization_id and l.workspace_id=er.workspace_id
    where er.session_id=${sessionId}
      and (${selectedRun}::uuid is null or er.run_id=${selectedRun}::uuid)
    group by er.run_id
  `;
  const usageByRun = new Map<string, RuntimeRunUsage>(
    usageRows.map((row) => {
      const inputTokens = row.receipts ? Number(row.input_tokens) : null;
      const outputTokens = row.receipts ? Number(row.output_tokens) : null;
      return [
        row.run_id,
        {
          inputTokens,
          outputTokens,
          totalTokens:
            inputTokens === null || outputTokens === null
              ? null
              : inputTokens + outputTokens,
          cachedInputTokens:
            row.receipts &&
            (row.cache_usage_known || Number(row.cached_input_tokens) > 0)
              ? Number(row.cached_input_tokens)
              : null,
          usageComplete: row.receipts > 0 && row.usage_complete,
          cacheUsageKnown: row.receipts > 0 && row.cache_usage_known,
          attemptCount: row.attempts,
          receiptCount: row.receipts,
        },
      ];
    }),
  );
  const timingByRun = await sql.begin((tx) =>
    readTaskClocks(tx, [...new Set(rows.map((row) => row.run_id))]),
  );
  const turns = new Map<
    string,
    {
      run: {
        id: string;
        status: string;
        createdAt: string | null;
        completedAt: string | null;
      };
      userMessage: { text: string | null; occurredAt: string | null };
      assistantMessage: {
        text: string | null;
        status: string;
        occurredAt: string | null;
      };
      events: NonNullable<ReturnType<typeof mapDshRuntimeEvent>>[];
      usage: RuntimeRunUsage | null;
      timing: TaskRuntimeTiming | null;
    }
  >();
  for (const row of rows) {
    let turn = turns.get(row.run_id);
    if (!turn) {
      turn = {
        run: {
          id: row.run_id,
          status: row.run_state,
          createdAt: timestamp(row.run_created_at),
          completedAt: timestamp(row.run_completed_at),
        },
        userMessage: {
          text: safeText(safeRecord(row.user_content).text, 40_000),
          occurredAt: timestamp(row.user_created_at),
        },
        assistantMessage: {
          text: safeText(safeRecord(row.assistant_content).text, 40_000),
          status: row.assistant_status,
          occurredAt: timestamp(
            row.assistant_completed_at ?? row.assistant_created_at,
          ),
        },
        events: [],
        timing: timingByRun.get(row.run_id) ?? null,
        usage: usageByRun.has(row.run_id)
          ? {
              ...usageByRun.get(row.run_id)!,
              usageComplete:
                usageByRun.get(row.run_id)!.usageComplete &&
                ['succeeded', 'failed', 'canceled'].includes(row.run_state),
            }
          : null,
      };
      turns.set(row.run_id, turn);
    }
    const event = mapDshRuntimeEvent(row);
    if (event) turn.events.push(event);
  }
  const orderedTurns = [...turns.values()];
  const latest = orderedTurns.at(-1)?.run ?? null;
  return {
    sessionId,
    run: latest ? { id: latest.id, status: latest.status } : null,
    turns: orderedTurns,
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
          active_turn_id = ${current.active_run_id === values.runId && !configChanged ? current.active_turn_id : null}, worker_id = ${values.workerId},
          config_checksum = ${values.configChecksum},
          thread_id = ${configChanged ? null : current.thread_id},
          usage_baseline_input_tokens = ${configChanged ? null : current.usage_baseline_input_tokens},
          last_input_tokens = ${configChanged ? null : current.last_input_tokens},
          last_cached_input_tokens = ${configChanged ? null : current.last_cached_input_tokens},
          dynamic_context_tokens = ${configChanged ? 0 : current.dynamic_context_tokens},
          compact_threshold_tokens = ${values.compactThresholdTokens},
          context_pressure_tokens = ${configChanged ? 0 : current.context_pressure_tokens},
          dsh_context_as_of_seq = ${configChanged ? null : current.dsh_context_as_of_seq},
          dsh_context_pressure_tokens = ${configChanged ? null : current.dsh_context_pressure_tokens},
          dsh_context_projected_tokens = ${configChanged ? null : current.dsh_context_projected_tokens},
          dsh_context_window_tokens = ${configChanged ? null : current.dsh_context_window_tokens},
          dsh_context_observed_at = ${configChanged ? null : current.dsh_context_observed_at},
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
          dsh_context_as_of_seq = ${changed ? null : current.dsh_context_as_of_seq},
          dsh_context_pressure_tokens = ${changed ? null : current.dsh_context_pressure_tokens},
          dsh_context_projected_tokens = ${changed ? null : current.dsh_context_projected_tokens},
          dsh_context_window_tokens = ${changed ? null : current.dsh_context_window_tokens},
          dsh_context_observed_at = ${changed ? null : current.dsh_context_observed_at},
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

export async function recordConversationNativeContext(input: {
  organizationId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  workerId: string;
  generation: number;
  asOfSeq?: number;
  pressureTokens?: number;
  projectedTokens?: number;
  contextWindow: number;
}) {
  const values = {
    ...ownedValues(input),
    generation: z.number().int().nonnegative().parse(input.generation),
    asOfSeq:
      input.asOfSeq === undefined
        ? null
        : z.number().int().nonnegative().parse(input.asOfSeq),
    pressureTokens:
      input.pressureTokens === undefined
        ? null
        : z.number().int().nonnegative().parse(input.pressureTokens),
    projectedTokens:
      input.projectedTokens === undefined
        ? null
        : z.number().int().nonnegative().parse(input.projectedTokens),
    contextWindow: z.number().int().positive().parse(input.contextWindow),
  };
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const current = await lockedOwnedRuntime(transaction, values);
    if (current.thread_generation !== values.generation) {
      throw new ConversationRuntimeError('conversation_ownership_lost');
    }
    const rows = await transaction<ConversationRuntimeRow[]>`
      update allrice_conversation_runtimes
      set dsh_context_as_of_seq = ${values.asOfSeq},
          dsh_context_pressure_tokens = ${values.pressureTokens},
          dsh_context_projected_tokens = ${values.projectedTokens},
          dsh_context_window_tokens = ${values.contextWindow},
          dsh_context_observed_at = now(),
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
    await cancelUnadoptedSteers(transaction, values.sessionId);
    const next = await transaction<{ run_id: string }[]>`
      select run_id from allrice_conversation_followups
      where organization_id = ${values.organizationId}
        and workspace_id = ${values.workspaceId}
        and session_id = ${values.sessionId}
        and state = 'queued'
        and mode <> 'steer_only'
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
