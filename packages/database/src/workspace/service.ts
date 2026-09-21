import { createHash } from 'node:crypto';
import { completedBudgetAnswers } from './budget-answer.ts';
import {
  ArtifactReviewError,
  assertWorkbenchSession,
} from '../artifact-review.ts';
import { prepareReviewContinuation } from '../conversation/review-continuation.ts';
import { prepareChangesetAction } from '../changeset-service.ts';
import {
  ChatMessageContentSchema,
  CorrectMemoryInputSchema,
  CreateCheckpointMemoryCandidateInputSchema,
  CreateChatSessionInputSchema,
  CreateWorkspaceMemoryInputSchema,
  MemoryRevisionSchema,
  SessionModelSnapshotSchema,
  SendChatMessageInputSchema,
  resolveAssistantPreference,
  defaultAssistantRunConfiguration,
  UpdateChatSessionInputSchema,
  UuidSchema,
  authorize,
  type ChatMessageSchema,
  type ChatSessionSchema,
  type EmployeeAssignmentSchema,
  type ImageMediaType,
  type RequestContext,
  type Visibility,
  type MemoryClass,
  type MemoryLifecycleState,
  type MemoryTrust,
  type WorkspaceMemorySchema,
} from '@allrice/contracts';
import { z } from 'zod';

import {
  DataAccessError,
  createMemory,
  createRagChunk,
  getStoredFile,
} from '../data.ts';
import { getDatabase } from '../core/client.ts';
import {
  assistantRuntimeEnabled,
  AssistantRuntimeError,
} from '../assistant-runtime.ts';
import {
  employeeManifestChecksum,
  riceEmployeeKey,
  riceManifest,
} from '../employees/employee-config.ts';
import {
  defaultContextCompactThreshold,
  sessionCompactionStatus,
} from '../conversation/usage.ts';
import {
  applyWorkspaceMemoryRecallBudget,
  embedWorkspaceText,
  rankWorkspaceMemoryRecallCandidates,
  workspaceMemoryRecallPolicy,
} from './memory-recall.ts';

export {
  applyWorkspaceMemoryRecallBudget,
  embedWorkspaceText,
  rankWorkspaceMemoryRecallCandidates,
  workspaceMemoryRecallPolicy,
} from './memory-recall.ts';
export type { RankedMemoryRecallCandidate } from './memory-recall.ts';

// Bump when the built-in Rice prompt contract changes so existing assignments
// receive the new version while historical Sessions remain pinned.
// Built-in Rice manifests are immutable once published. Bump this whenever
// the default employee capability contract changes so existing sessions stay
// frozen while newly provisioned sessions receive the updated tool set.
const riceVersion = 10;

type ChatSession = z.infer<typeof ChatSessionSchema>;
type ChatMessage = z.infer<typeof ChatMessageSchema>;
type EmployeeAssignment = z.infer<typeof EmployeeAssignmentSchema>;
type WorkspaceMemory = z.infer<typeof WorkspaceMemorySchema>;

interface AssignmentRow {
  assignment_id: string;
  employee_id: string;
  employee_version_id: string;
  user_id: string;
  organization_id: string;
  workspace_id: string;
  is_default: boolean;
  version: number;
  name: string;
  model: string;
  system_prompt: string;
  capabilities: unknown;
  published_at: Date;
  config_checksum: string;
}

interface SessionRow {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  employee_assignment_id: string;
  employee_version_id: string;
  title: string;
  visibility: Visibility;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  owner_id: string;
  role: ChatMessage['role'];
  content: unknown;
  status: ChatMessage['status'];
  error_code?: string | null;
  client_message_id: string | null;
  reply_to_id: string | null;
  created_at: Date;
  completed_at: Date | null;
  run_id?: string | null;
  question_answer_payload?: string | null;
}

interface AttachmentRow {
  message_id: string;
  object_id: string;
  owner_id: string;
  file_name: string;
  media_type: string;
  size_bytes: number | string;
  visibility: Visibility;
  state: 'pending' | 'ready' | 'deleted';
}

interface MemoryRow {
  id: string;
  organization_id: string;
  workspace_id: string;
  employee_id: string | null;
  owner_id: string;
  content: string;
  visibility: Visibility;
  source_type: WorkspaceMemory['sourceType'];
  source_id: string | null;
  lifecycle_state: MemoryLifecycleState;
  memory_class: MemoryClass;
  revision: number;
  trust_level: WorkspaceMemory['trust'];
  confidence: number | string;
  source_label: string;
  captured_at: Date;
  expires_at: Date | null;
  last_verified_at: Date | null;
  supersedes_memory_id: string | null;
  last_recalled_at: Date | null;
  recall_count: number;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

interface MemoryRecallRow {
  id: string;
  revision: number;
  content: string;
  source_type: WorkspaceMemory['sourceType'];
  source_id: string | null;
  lifecycle_state: MemoryLifecycleState;
  memory_class: MemoryClass;
  trust_level: MemoryTrust;
  confidence: number | string;
  source_label: string;
  captured_at: Date;
  updated_at: Date;
  vector_score: number | string;
  lexical_score: number | string;
}

function requireUser(context: RequestContext) {
  if (context.actor.type !== 'user') {
    throw new DataAccessError('authentication_required');
  }
  return context.actor.id;
}

function hasWorkspaceAccess(context: RequestContext, workspaceId: string) {
  const userId = requireUser(context);
  return context.memberships.some(
    (membership) =>
      membership.active &&
      membership.userId === userId &&
      membership.organizationId === context.organizationId &&
      (membership.workspaceId === null ||
        membership.workspaceId === workspaceId),
  );
}

async function audit(input: {
  context: RequestContext;
  workspaceId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  decision?: 'allowed' | 'denied' | 'recorded';
  reason: string;
}) {
  const sql = getDatabase();
  await sql`
    insert into allrice_audit_events (
      organization_id, workspace_id, actor_id, action, resource_type,
      resource_id, decision, reason, request_id
    ) values (
      ${input.context.organizationId}, ${input.workspaceId},
      ${requireUser(input.context)}, ${input.action}, ${input.resourceType},
      ${input.resourceId}, ${input.decision ?? 'allowed'}, ${input.reason},
      ${input.context.requestId}
    )
  `;
}

export async function resolveWorkspaceId(
  context: RequestContext,
  requestedWorkspaceId?: string,
) {
  const requested = requestedWorkspaceId
    ? UuidSchema.parse(requestedWorkspaceId)
    : context.workspaceId;
  const sql = getDatabase();
  const rows = requested
    ? await sql<{ id: string }[]>`
        select id from allrice_workspaces
        where organization_id = ${context.organizationId}
          and id = ${requested}
          and archived_at is null
      `
    : await sql<{ id: string }[]>`
        select w.id
        from allrice_workspaces w
        where w.organization_id = ${context.organizationId}
          and w.archived_at is null
          and exists (
            select 1 from allrice_memberships m
            where m.user_id = ${requireUser(context)}
              and m.organization_id = w.organization_id
              and m.active
              and (m.workspace_id is null or m.workspace_id = w.id)
          )
        order by w.created_at, w.id
        limit 1
      `;
  const workspaceId = rows[0]?.id;
  if (!workspaceId || !hasWorkspaceAccess(context, workspaceId)) {
    throw new DataAccessError('authorization_denied');
  }
  return workspaceId;
}

function mapAssignment(row: AssignmentRow): EmployeeAssignment {
  return {
    id: row.assignment_id,
    employeeId: row.employee_id,
    employeeVersionId: row.employee_version_id,
    userId: row.user_id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    isDefault: row.is_default,
    version: {
      id: row.employee_version_id,
      employeeId: row.employee_id,
      version: row.version,
      name: row.name,
      model: row.model,
      systemPrompt: row.system_prompt,
      capabilities: z.array(z.string()).parse(row.capabilities),
      publishedAt: row.published_at.toISOString(),
    },
  };
}

export async function ensureDefaultEmployee(
  context: RequestContext,
  requestedWorkspaceId?: string,
) {
  const workspaceId = await resolveWorkspaceId(context, requestedWorkspaceId);
  const userId = requireUser(context);
  const manifest = riceManifest();
  const checksum = employeeManifestChecksum(manifest);
  const sql = getDatabase();
  const assignment = await sql.begin(async (transaction) => {
    const employees = await transaction<{ id: string }[]>`
      insert into allrice_employees (
        organization_id, workspace_id, employee_key, name
      ) values (
        ${context.organizationId}, ${workspaceId},
        ${riceEmployeeKey}, ${manifest.name}
      )
      on conflict (organization_id, workspace_id, employee_key)
      do update set name = excluded.name, updated_at = now()
      returning id
    `;
    const employeeId = employees[0]?.id;
    if (!employeeId) throw new Error('default employee provisioning failed');
    await transaction`
      insert into allrice_employee_versions (
        organization_id, workspace_id, employee_id, version, name, model,
        system_prompt, capabilities, config_checksum, description, manifest,
        provider_snapshot, skill_version_ids
      ) values (
        ${context.organizationId}, ${workspaceId}, ${employeeId},
        ${riceVersion}, ${manifest.name},
        ${manifest.provider.model}, ${manifest.systemPrompt},
        ${transaction.json(manifest.capabilities)}, ${checksum},
        ${manifest.description}, ${transaction.json(manifest)},
        ${transaction.json(manifest.provider)},
        ${transaction.json(manifest.skillVersionIds)}
      )
      on conflict (employee_id, version) do nothing
    `;
    const versions = await transaction<
      { id: string; config_checksum: string; version: number }[]
    >`
      select id, config_checksum, version from allrice_employee_versions
      where employee_id = ${employeeId}
      order by version desc
      limit 1
    `;
    const version = versions[0];
    if (!version) throw new Error('published Rice version is missing');
    await transaction`
      insert into allrice_employee_assignments (
        organization_id, workspace_id, employee_id, employee_version_id,
        user_id, is_default, active
      ) values (
        ${context.organizationId}, ${workspaceId}, ${employeeId},
        ${version.id}, ${userId},
        not exists (
          select 1 from allrice_employee_assignments current_default
          where current_default.organization_id = ${context.organizationId}
            and current_default.workspace_id = ${workspaceId}
            and current_default.user_id = ${userId}
            and current_default.active and current_default.is_default
        ),
        true
      )
      on conflict (organization_id, workspace_id, user_id, employee_id)
      do update set active = true,
        employee_version_id = case
          when exists (
            select 1 from allrice_employee_versions current_version
            where current_version.id = allrice_employee_assignments.employee_version_id
              and (
                current_version.model = 'allrice/basic-assistant-v1'
                or current_version.version < ${riceVersion}
              )
          ) then excluded.employee_version_id
          else allrice_employee_assignments.employee_version_id
        end,
        updated_at = now()
    `;
    const rows = await transaction<AssignmentRow[]>`
      select
        a.id as assignment_id, a.employee_id, a.employee_version_id,
        a.user_id, a.organization_id, a.workspace_id, a.is_default,
        v.version, v.name, v.model, v.system_prompt, v.capabilities,
        v.published_at, v.config_checksum
      from allrice_employee_assignments a
      join allrice_employee_versions v on v.id = a.employee_version_id
      where a.organization_id = ${context.organizationId}
        and a.workspace_id = ${workspaceId}
        and a.user_id = ${userId}
        and a.active and a.is_default
    `;
    return rows[0];
  });
  if (!assignment) throw new Error('default employee assignment failed');
  return mapAssignment(assignment);
}

function mapSession(row: SessionRow): ChatSession {
  return {
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    employeeAssignmentId: row.employee_assignment_id,
    employeeVersionId: row.employee_version_id,
    title: row.title,
    visibility: row.visibility,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at?.toISOString() ?? null,
  };
}

function canReadSession(context: RequestContext, row: SessionRow) {
  return authorize(
    {
      type: 'chat_session',
      id: row.id,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      ownerId: row.owner_id,
      visibility: row.visibility,
      archivedAt: row.archived_at?.toISOString() ?? null,
    },
    'resource:read',
    context,
  ).allowed;
}

async function sessionRow(
  context: RequestContext,
  workspaceId: string,
  sessionId: string,
) {
  if (!hasWorkspaceAccess(context, workspaceId)) {
    throw new DataAccessError('authorization_denied');
  }
  const sql = getDatabase();
  const rows = await sql<SessionRow[]>`
    select * from allrice_chat_sessions
    where organization_id = ${context.organizationId}
      and workspace_id = ${UuidSchema.parse(workspaceId)}
      and id = ${UuidSchema.parse(sessionId)}
  `;
  const row = rows[0];
  if (!row) throw new DataAccessError('not_found');
  if (!canReadSession(context, row)) {
    await audit({
      context,
      workspaceId,
      action: 'session.read',
      resourceType: 'chat_session',
      resourceId: row.id,
      decision: 'denied',
      reason: 'resource_policy_denied',
    });
    throw new DataAccessError('authorization_denied');
  }
  return row;
}

export async function createChatSession(
  context: RequestContext,
  input: unknown,
) {
  const parsed = CreateChatSessionInputSchema.parse(input);
  const defaultAssignment = await ensureDefaultEmployee(
    context,
    parsed.workspaceId,
  );
  const sql = getDatabase();
  let assignment = defaultAssignment;
  if (parsed.employeeAssignmentId) {
    const assignments = await sql<AssignmentRow[]>`
      select
        a.id as assignment_id, a.employee_id, a.employee_version_id,
        a.user_id, a.organization_id, a.workspace_id, a.is_default,
        v.version, v.name, v.model, v.system_prompt, v.capabilities,
        v.published_at, v.config_checksum
      from allrice_employee_assignments a
      join allrice_employee_versions v on v.id = a.employee_version_id
      where a.id = ${parsed.employeeAssignmentId}
        and a.organization_id = ${context.organizationId}
        and a.workspace_id = ${defaultAssignment.workspaceId}
        and a.user_id = ${requireUser(context)} and a.active
    `;
    if (!assignments[0]) throw new DataAccessError('authorization_denied');
    assignment = mapAssignment(assignments[0]);
  }
  // New Sessions always use the assignment's current published version.
  // Browser state can be stale after an administrator updates an employee;
  // accepting its version would silently pin a new Session to old abilities.
  const employeeVersionId = assignment.employeeVersionId;
  const versions = await sql<{ id: string }[]>`
    select id from allrice_employee_versions
    where id = ${employeeVersionId}
      and organization_id = ${context.organizationId}
      and workspace_id = ${defaultAssignment.workspaceId}
      and employee_id = ${assignment.employeeId}
      and provider_snapshot ->> 'provider' in ('codex', 'dsh')
  `;
  if (!versions[0]) throw new DataAccessError('authorization_denied');
  const rows = await sql<SessionRow[]>`
    insert into allrice_chat_sessions (
      organization_id, workspace_id, owner_id, employee_assignment_id,
      employee_version_id, title, visibility
    ) values (
      ${context.organizationId}, ${defaultAssignment.workspaceId}, ${requireUser(context)},
      ${assignment.id}, ${employeeVersionId}, ${parsed.title}, 'private'
    )
    returning *
  `;
  const row = rows[0];
  if (!row) throw new Error('session creation failed');
  await audit({
    context,
    workspaceId: defaultAssignment.workspaceId,
    action: 'session.create',
    resourceType: 'chat_session',
    resourceId: row.id,
    reason: 'owner_with_workspace_membership',
  });
  return mapSession(row);
}

function decodeCursor(cursor: string | undefined) {
  if (!cursor) return null;
  try {
    const parsed = z
      .object({ updatedAt: z.string().datetime(), id: UuidSchema })
      .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return { updatedAt: new Date(parsed.updatedAt), id: parsed.id };
  } catch {
    throw new DataAccessError('not_found');
  }
}

export async function listChatSessions(
  context: RequestContext,
  workspaceIdInput: string,
  options: { cursor?: string; limit?: number; includeArchived?: boolean } = {},
) {
  const workspaceId = await resolveWorkspaceId(context, workspaceIdInput);
  const cursor = decodeCursor(options.cursor);
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
  const sql = getDatabase();
  const rows = await sql<SessionRow[]>`
    select * from allrice_chat_sessions
    where organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId}
      and (${options.includeArchived ?? false} or archived_at is null)
      and (owner_id = ${requireUser(context)} or visibility <> 'private')
      and (
        ${cursor?.updatedAt ?? null}::timestamptz is null
        or (updated_at, id) < (${cursor?.updatedAt ?? null}, ${cursor?.id ?? null}::uuid)
      )
    order by updated_at desc, id desc
    limit ${limit + 1}
  `;
  const visible = rows.filter((row) => canReadSession(context, row));
  const page = visible.slice(0, limit);
  const last = page.at(-1);
  return {
    sessions: page.map(mapSession),
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              updatedAt: last.updated_at.toISOString(),
              id: last.id,
            }),
          ).toString('base64url')
        : null,
  };
}

export async function updateChatSession(
  context: RequestContext,
  workspaceId: string,
  sessionId: string,
  input: unknown,
) {
  const update = UpdateChatSessionInputSchema.parse(input);
  const current = await sessionRow(context, workspaceId, sessionId);
  if (current.owner_id !== requireUser(context)) {
    throw new DataAccessError('authorization_denied');
  }
  const sql = getDatabase();
  const row = await sql.begin(async (transaction) => {
    const rows = await transaction<SessionRow[]>`
      update allrice_chat_sessions
      set title = coalesce(${update.title ?? null}, title),
          visibility = coalesce(${update.visibility ?? null}, visibility),
          archived_at = case
            when ${update.archived ?? null}::boolean is true then coalesce(archived_at, now())
            when ${update.archived ?? null}::boolean is false then null
            else archived_at
          end,
          updated_at = now()
      where id = ${current.id}
      returning *
    `;
    if (update.visibility) {
      await transaction`
        update allrice_messages set visibility = ${update.visibility}
        where organization_id = ${context.organizationId}
          and workspace_id = ${workspaceId}
          and session_id = ${current.id}
      `;
    }
    return rows[0];
  });
  if (!row) throw new DataAccessError('not_found');
  await audit({
    context,
    workspaceId,
    action: update.archived === true ? 'session.archive' : 'session.update',
    resourceType: 'chat_session',
    resourceId: row.id,
    reason: 'resource_owner',
  });
  return mapSession(row);
}

async function messageAttachments(messageIds: string[]) {
  if (messageIds.length === 0) return new Map<string, AttachmentRow[]>();
  const sql = getDatabase();
  const rows = await sql<AttachmentRow[]>`
    select
      a.message_id, a.object_id, o.owner_id, a.file_name,
      o.media_type, o.size_bytes, o.visibility, o.state
    from allrice_message_attachments a
    join allrice_storage_objects o on o.id = a.object_id
    where a.message_id in ${sql(messageIds)}
  `;
  const grouped = new Map<string, AttachmentRow[]>();
  for (const row of rows) {
    const values = grouped.get(row.message_id) ?? [];
    values.push(row);
    grouped.set(row.message_id, values);
  }
  return grouped;
}

function mapMessage(
  context: RequestContext,
  row: MessageRow,
  attachments: AttachmentRow[],
): ChatMessage {
  const userId = requireUser(context);
  const storedContent = ChatMessageContentSchema.parse(row.content);
  let content = storedContent;
  const prefix = 'allrice:user-question:v1:';
  if (
    !storedContent.interaction &&
    row.question_answer_payload?.startsWith(prefix)
  ) {
    try {
      const candidate = ChatMessageContentSchema.safeParse({
        ...storedContent,
        interaction: {
          type: 'user_question_answer',
          answer: JSON.parse(row.question_answer_payload.slice(prefix.length)),
        },
      });
      if (candidate.success) content = candidate.data;
    } catch {
      // Historical command evidence can be malformed without breaking history.
    }
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    ownerId: row.owner_id,
    role: row.role,
    content,
    status: row.status,
    errorCode: row.error_code ?? null,
    clientMessageId: row.client_message_id,
    replyToId: row.reply_to_id,
    runId: row.run_id ?? null,
    attachments: attachments.map((attachment) => {
      const restricted =
        attachment.state !== 'ready' ||
        (attachment.visibility === 'private' && attachment.owner_id !== userId);
      return {
        id: attachment.object_id,
        fileName: restricted ? 'Restricted attachment' : attachment.file_name,
        mediaType: restricted
          ? 'application/octet-stream'
          : attachment.media_type,
        sizeBytes: restricted ? 0 : Number(attachment.size_bytes),
        restricted,
      };
    }),
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

export async function getChatSessionHistory(
  context: RequestContext,
  workspaceId: string,
  sessionId: string,
) {
  const row = await sessionRow(context, workspaceId, sessionId);
  const sql = getDatabase();
  const messages = await sql<MessageRow[]>`
    select m.*, er.run_id,
      question_command.message as question_answer_payload
    from allrice_messages m
    left join allrice_employee_runs er on er.assistant_message_id = m.id
    left join allrice_conversation_followups question_followup
      on question_followup.user_message_id = m.id
      and question_followup.organization_id = m.organization_id
      and question_followup.workspace_id = m.workspace_id
    left join allrice_conversation_commands question_command
      on question_command.followup_run_id = question_followup.run_id
      and question_command.organization_id = m.organization_id
      and question_command.workspace_id = m.workspace_id
      and question_command.message like 'allrice:user-question:v1:%'
    where m.organization_id = ${context.organizationId}
      and m.workspace_id = ${workspaceId}
      and m.session_id = ${row.id}
    order by
      m.created_at,
      case when m.role = 'user' then 0 else 1 end,
      m.id
  `;
  const runtimes = await sql<
    {
      context_pressure_tokens: number;
      compact_threshold_tokens: number;
      dsh_context_as_of_seq: number | null;
      dsh_context_pressure_tokens: number | null;
      dsh_context_projected_tokens: number | null;
      dsh_context_window_tokens: number | null;
      dsh_context_observed_at: Date | string | null;
    }[]
  >`
    select context_pressure_tokens, compact_threshold_tokens,
      dsh_context_as_of_seq, dsh_context_pressure_tokens,
      dsh_context_projected_tokens, dsh_context_window_tokens,
      dsh_context_observed_at
    from allrice_conversation_runtimes
    where organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId}
      and session_id = ${row.id}
      and owner_id = ${row.owner_id}
  `;
  const contextStatus = sessionCompactionStatus({
    pressureTokens: runtimes[0]?.context_pressure_tokens ?? 0,
    thresholdTokens:
      runtimes[0]?.compact_threshold_tokens ?? defaultContextCompactThreshold,
  });
  const nativeRuntime = runtimes[0];
  const nativeUsedTokens =
    nativeRuntime?.dsh_context_projected_tokens ??
    nativeRuntime?.dsh_context_pressure_tokens ??
    null;
  const nativeWindowTokens = nativeRuntime?.dsh_context_window_tokens ?? null;
  const nativeContextStatus =
    nativeUsedTokens !== null &&
    nativeWindowTokens !== null &&
    nativeWindowTokens > 0
      ? {
          source: 'dsh' as const,
          usedTokens: nativeUsedTokens,
          contextWindowTokens: nativeWindowTokens,
          percentage: Math.min(
            100,
            Math.max(
              0,
              Math.round((nativeUsedTokens / nativeWindowTokens) * 100),
            ),
          ),
          asOfSeq: nativeRuntime?.dsh_context_as_of_seq ?? null,
          observedAt:
            nativeRuntime?.dsh_context_observed_at instanceof Date
              ? nativeRuntime.dsh_context_observed_at.toISOString()
              : (nativeRuntime?.dsh_context_observed_at ?? null),
        }
      : null;
  const attachments = await messageAttachments(
    messages.map((message) => message.id),
  );
  const recovered = await completedBudgetAnswers({
    organizationId: context.organizationId,
    workspaceId,
    ownerId: row.owner_id,
    sessionId: row.id,
    runIds: messages
      .filter(
        (m) =>
          m.status === 'failed' &&
          [
            'MODEL_OUTPUT_BUDGET_EXCEEDED',
            'MODEL_TOTAL_TOKEN_BUDGET_EXCEEDED',
          ].includes(m.error_code ?? ''),
      )
      .flatMap((m) => (m.run_id ? [m.run_id] : [])),
  });
  return {
    session: mapSession(row),
    contextStatus,
    nativeContextStatus,
    messages: messages.map((message) => {
      const mapped = mapMessage(
        context,
        message,
        attachments.get(message.id) ?? [],
      );
      const text = recovered.get(message.run_id ?? '');
      if (text)
        mapped.content = {
          ...mapped.content,
          text,
          budgetWarning:
            message.error_code === 'MODEL_TOTAL_TOKEN_BUDGET_EXCEEDED'
              ? 'MODEL_TOTAL_TOKEN_BUDGET_EXCEEDED'
              : 'MODEL_OUTPUT_BUDGET_EXCEEDED',
        };
      return mapped;
    }),
  };
}

function vectorLiteral(values: number[]) {
  return `[${values.join(',')}]`;
}

async function loadWorkspaceMemoryRecallCandidates(input: {
  context: RequestContext;
  workspaceId: string;
  employeeId?: string;
  query: string;
  poolSize: number;
  durableOnly: boolean;
}) {
  const sql = getDatabase();
  const employeeScope = input.employeeId ?? null;
  const embedding = vectorLiteral(embedWorkspaceText(input.query));
  const rows = await sql<MemoryRecallRow[]>`
    select m.id, m.revision, m.content, m.source_type, m.source_id,
      m.lifecycle_state, m.memory_class, m.trust_level, m.confidence,
      m.source_label, m.captured_at, m.updated_at,
      greatest(0, 1 - (c.embedding <=> ${embedding}::vector)) as vector_score,
      greatest(
        similarity(lower(m.content), lower(${input.query})),
        word_similarity(lower(${input.query}), lower(m.content)),
        case
          when position(lower(${input.query}) in lower(m.content)) > 0 then 1
          else 0
        end
      ) as lexical_score
    from allrice_rag_chunks c
    join allrice_memories m
      on m.organization_id = c.organization_id
     and m.workspace_id = c.workspace_id
     and m.id = c.memory_id
    where c.organization_id = ${input.context.organizationId}
      and c.workspace_id = ${input.workspaceId}
      and m.archived_at is null
      and (
        ${input.durableOnly}::boolean = false
        or (
          m.lifecycle_state = 'durable'
          and m.trust_level in ('user_confirmed', 'platform_verified', 'derived')
          and m.confidence >= 0.5
        )
      )
      and (m.expires_at is null or m.expires_at > now())
      and (${employeeScope}::uuid is null or m.employee_id is null or m.employee_id = ${employeeScope})
      and (c.owner_id = ${requireUser(input.context)} or c.visibility <> 'private')
    order by greatest(
      greatest(0, 1 - (c.embedding <=> ${embedding}::vector)),
      word_similarity(lower(${input.query}), lower(m.content))
    ) desc, m.updated_at desc
    limit ${input.poolSize}
  `;
  return rows.map((row) => ({
    id: row.id,
    revision: row.revision,
    content: row.content,
    sourceType: row.source_type,
    sourceId: row.source_id,
    lifecycleState: row.lifecycle_state,
    memoryClass: row.memory_class,
    trust: row.trust_level,
    confidence: Number(row.confidence),
    sourceLabel: row.source_label,
    capturedAt: row.captured_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    vectorScore: Number(row.vector_score),
    lexicalScore: Number(row.lexical_score),
  }));
}

async function recallForReply(
  context: RequestContext,
  workspaceId: string,
  employeeId: string | undefined,
  text: string,
) {
  const candidates = await loadWorkspaceMemoryRecallCandidates({
    context,
    workspaceId,
    employeeId,
    query: text,
    poolSize: 60,
    durableOnly: true,
  });
  const recalled = applyWorkspaceMemoryRecallBudget(
    rankWorkspaceMemoryRecallCandidates(candidates, {
      threshold: workspaceMemoryRecallPolicy.automaticThreshold,
      limit: workspaceMemoryRecallPolicy.maximumAutomaticResults,
      durableOnly: true,
    }),
    workspaceMemoryRecallPolicy.maximumAutomaticTokens,
  );
  if (recalled.length > 0) {
    const sql = getDatabase();
    const recalledIds = recalled.map((memory) => memory.id);
    await sql`
      update allrice_memories
      set last_recalled_at = now(), recall_count = recall_count + 1
      where organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId}
        and id in ${sql(recalledIds)}
    `;
  }
  return recalled.map((memory) => ({
    id: memory.id,
    revision: memory.revision,
    content: memory.content,
    lifecycleState: memory.lifecycleState,
    memoryClass: memory.memoryClass,
    sourceLabel: memory.sourceLabel,
    trust: memory.trust,
    confidence: memory.confidence,
    capturedAt: memory.capturedAt,
  }));
}

export async function searchWorkspaceMemories(
  context: RequestContext,
  input: { workspaceId: string; query: string; limit?: number },
) {
  const workspaceId = await resolveWorkspaceId(context, input.workspaceId);
  const query = z.string().trim().min(1).max(4_000).parse(input.query);
  const limit = z.number().int().min(1).max(20).default(5).parse(input.limit);
  const candidates = await loadWorkspaceMemoryRecallCandidates({
    context,
    workspaceId,
    query,
    poolSize: Math.min(
      workspaceMemoryRecallPolicy.maximumCandidatePool,
      Math.max(60, limit * 12),
    ),
    durableOnly: false,
  });
  return rankWorkspaceMemoryRecallCandidates(candidates, {
    threshold: workspaceMemoryRecallPolicy.explicitThreshold,
    limit,
    durableOnly: false,
  }).map((memory) => ({
    id: memory.id,
    content: memory.content,
    source_type: memory.sourceType,
    source_id: memory.sourceId,
    lifecycle_state: memory.lifecycleState,
    memory_class: memory.memoryClass,
    trust_level: memory.trust,
    confidence: memory.confidence,
    source_label: memory.sourceLabel,
    relevance_score: memory.relevanceScore,
  }));
}

export async function authorizeSessionOwner(
  context: RequestContext,
  workspaceId: string,
  sessionId: string,
) {
  const session = await sessionRow(context, workspaceId, sessionId);
  if (session.owner_id !== requireUser(context) || session.archived_at) {
    throw new DataAccessError('authorization_denied');
  }
  return mapSession(session);
}

export async function sendChatMessage(
  context: RequestContext,
  workspaceId: string,
  sessionId: string,
  input: unknown,
) {
  const message = SendChatMessageInputSchema.parse(input);
  const requestDigest = `sha256:${createHash('sha256').update(JSON.stringify(message)).digest('hex')}`;
  const assistantPreference =
    message.deliveryMode === 'follow_up' &&
    !message.userQuestionAnswer &&
    !message.reviewContinuation &&
    !message.changesetAction
      ? resolveAssistantPreference(message.assistantPreference, message.text)
      : undefined;
  const conversationMessage = message.userQuestionAnswer
    ? `allrice:user-question:v1:${JSON.stringify(message.userQuestionAnswer)}`
    : message.text;
  const session = await sessionRow(context, workspaceId, sessionId);
  if (session.owner_id !== requireUser(context) || session.archived_at) {
    throw new DataAccessError('authorization_denied');
  }
  const sql = getDatabase();
  const employeeRows = await sql<
    { employee_id: string; employee_version_id: string }[]
  >`
    select employee_id, employee_version_id from allrice_employee_assignments
    where id = ${session.employee_assignment_id}
      and organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId}
      and active
  `;
  const currentAssignment = employeeRows[0];
  if (!currentAssignment) throw new DataAccessError('not_found');
  // A published employee revision applies to the next turn of an existing
  // Session. Already-enqueued Runs keep their immutable execution snapshot,
  // while the tenant gets new Skills and policy without opening a new chat.
  const effectiveEmployeeVersionId = currentAssignment.employee_version_id;
  if (session.employee_version_id !== effectiveEmployeeVersionId) {
    await sql`
      update allrice_chat_sessions
      set employee_version_id = ${effectiveEmployeeVersionId}, updated_at = now()
      where id = ${session.id}
        and organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId}
        and employee_assignment_id = ${session.employee_assignment_id}
        and employee_version_id = ${session.employee_version_id}
    `;
    await audit({
      context,
      workspaceId,
      action: 'session.employee.version.refresh',
      resourceType: 'chat_session',
      resourceId: session.id,
      reason: 'active_assignment_version_applied_on_next_turn',
    });
  }
  const memories = await recallForReply(
    context,
    workspaceId,
    currentAssignment.employee_id,
    message.text,
  );
  const result = await sql.begin(async (transaction) => {
    await transaction`
      select pg_advisory_xact_lock(
        hashtextextended(${`${session.id}:${message.clientMessageId}`}, 50)
      )
    `;
    await assertWorkbenchSession(
      transaction,
      { ...context, workspaceId },
      session.id,
      true,
    );
    const existing = await transaction<MessageRow[]>`
      select * from allrice_messages
      where session_id = ${session.id}
        and owner_id = ${requireUser(context)}
        and client_message_id = ${message.clientMessageId}
    `;
    let userMessage = existing[0];
    if (userMessage) {
      const [receipt] = await transaction<{ request_digest: string }[]>`
        select request_digest from allrice_chat_input_requests where user_message_id=${userMessage.id}`;
      if (
        (receipt && receipt.request_digest !== requestDigest) ||
        (!receipt &&
          (ChatMessageContentSchema.parse(userMessage.content).text !==
            message.text ||
            message.reviewContinuation ||
            message.changesetAction ||
            message.assistantPreference))
      )
        throw new ArtifactReviewError('input_id_conflict');
      message.text = ChatMessageContentSchema.parse(userMessage.content).text;
    }
    if (!userMessage) {
      if (message.changesetAction)
        message.text = (
          await prepareChangesetAction(
            transaction,
            { ...context, workspaceId },
            session.id,
            message.changesetAction,
          )
        ).text;
      if (message.reviewContinuation) {
        message.text = (
          await prepareReviewContinuation(
            transaction,
            { ...context, workspaceId },
            session.id,
            message.reviewContinuation,
          )
        ).text;
      }
      if (message.attachmentIds.length > 0) {
        const files = await transaction<
          { id: string; owner_id: string; file_name: string }[]
        >`
          select o.id, o.owner_id, f.file_name
          from allrice_storage_objects o
          join allrice_file_references f on f.object_id = o.id
          where o.id in ${transaction(message.attachmentIds)}
            and o.organization_id = ${context.organizationId}
            and o.workspace_id = ${workspaceId}
            and (o.owner_id = ${requireUser(context)} or o.visibility <> 'private')
            and o.state = 'ready'
            and f.session_id = ${session.id}
        `;
        if (files.length !== new Set(message.attachmentIds).size) {
          throw new DataAccessError('authorization_denied');
        }
      }
      const users = await transaction<MessageRow[]>`
        insert into allrice_messages (
          organization_id, workspace_id, session_id, owner_id, role,
          content, visibility, client_message_id, status, completed_at
        ) values (
          ${context.organizationId}, ${workspaceId}, ${session.id},
          ${requireUser(context)}, 'user',
          ${transaction.json({
            text: message.text,
            citations: [],
            ...(message.changesetAction
              ? {
                  interaction: {
                    type: 'changeset_request',
                    action: message.changesetAction,
                  },
                }
              : {}),
            ...(message.userQuestionAnswer
              ? {
                  interaction: {
                    type: 'user_question_answer',
                    answer: message.userQuestionAnswer,
                  },
                }
              : {}),
            ...(message.reviewContinuation
              ? {
                  interaction: {
                    type: 'review_response',
                    review: message.reviewContinuation,
                  },
                }
              : {}),
          })},
          ${session.visibility}, ${message.clientMessageId}, 'completed', now()
        )
        returning *
      `;
      userMessage = users[0];
      if (!userMessage) throw new Error('user message creation failed');
      await transaction`insert into allrice_chat_input_requests
        (user_message_id,organization_id,workspace_id,session_id,owner_id,client_message_id,request_digest,kind)
        values (${userMessage.id},${context.organizationId},${workspaceId},${session.id},${context.actor.id},
        ${message.clientMessageId},${requestDigest},${
          (message.changesetAction
            ? 'changeset_request'
            : message.reviewContinuation?.kind) ??
          (message.userQuestionAnswer
            ? 'ask_user'
            : message.deliveryMode === 'steer'
              ? 'steer_current'
              : message.deliveryMode === 'follow_up'
                ? 'queue_next'
                : 'message')
        })`;
      if (message.attachmentIds.length > 0) {
        for (const objectId of new Set(message.attachmentIds)) {
          await transaction`
            insert into allrice_message_attachments (
              organization_id, workspace_id, message_id, object_id,
              attached_by, file_name
            )
            select
              ${context.organizationId}, ${workspaceId}, ${userMessage.id},
              o.id, ${requireUser(context)},
              f.file_name
            from allrice_storage_objects o
            join allrice_file_references f on f.object_id = o.id
            where o.id = ${objectId} and f.session_id = ${session.id}
            on conflict (message_id, object_id) do nothing
          `;
        }
      }
    }
    const existingReplies = await transaction<MessageRow[]>`
      select * from allrice_messages
      where session_id = ${session.id}
        and reply_to_id = ${userMessage.id}
        and role = 'assistant'
      order by created_at
      limit 1
    `;
    let assistantMessage = existingReplies[0];
    if (!assistantMessage) {
      const replies = await transaction<MessageRow[]>`
        insert into allrice_messages (
          organization_id, workspace_id, session_id, owner_id, role,
          content, visibility, reply_to_id, status, completed_at
        ) values (
          ${context.organizationId}, ${workspaceId}, ${session.id},
          ${requireUser(context)}, 'assistant',
          ${transaction.json({ text: 'Rice 正在处理…', citations: [] })},
          ${session.visibility}, ${userMessage.id}, 'pending', null
        )
        returning *
      `;
      assistantMessage = replies[0];
    }
    if (!assistantMessage) throw new Error('assistant message creation failed');
    await transaction`
      update allrice_chat_sessions set updated_at = now()
      where id = ${session.id}
    `;
    return { userMessage, assistantMessage };
  });
  await audit({
    context,
    workspaceId,
    action: 'message.create',
    resourceType: 'message',
    resourceId: result.userMessage.id,
    reason: 'session_owner_idempotent',
  });
  const existingEmployeeRuns = await sql<{ run_id: string }[]>`
    select run_id from allrice_employee_runs
    where organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId}
      and assistant_message_id = ${result.assistantMessage.id}
  `;
  if (existingEmployeeRuns[0]) {
    const { getRun } = await import('../execution/queue.ts');
    const [delivery] = await sql<
      { mode: string; active_run_id: string | null; state: string }[]
    >`
      select f.mode,c.state,cr.active_run_id from allrice_conversation_followups f
      left join allrice_conversation_commands c on c.followup_run_id=f.run_id
      left join allrice_conversation_runtimes cr on cr.session_id=f.session_id
      and cr.thread_generation=c.expected_generation and cr.active_turn_id=c.expected_turn_id
      where f.run_id=${existingEmployeeRuns[0].run_id}`;
    const steered = delivery?.mode !== 'follow_up' && delivery?.active_run_id;
    return {
      userMessage: mapMessage(context, result.userMessage, []),
      assistantMessage: mapMessage(context, result.assistantMessage, []),
      run: await getRun(
        context,
        workspaceId,
        steered ? delivery.active_run_id! : existingEmployeeRuns[0].run_id,
      ),
      delivery: delivery
        ? steered
          ? 'steer_pending'
          : 'follow_up'
        : 'immediate',
      fallbackRunId: delivery ? existingEmployeeRuns[0].run_id : null,
      created: false,
    };
  }
  if (result.assistantMessage.status === 'failed') {
    const retries = await sql<MessageRow[]>`
      update allrice_messages
      set content = ${sql.json({ text: 'Rice 正在重试…', citations: [] })},
          status = 'pending', error_code = null, completed_at = null
      where id = ${result.assistantMessage.id}
      returning *
    `;
    if (retries[0]) result.assistantMessage = retries[0];
  }
  const historyRows = await sql<MessageRow[]>`
    select * from allrice_messages
    where organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId}
      and session_id = ${session.id}
      and status = 'completed'
      and id <> ${result.userMessage.id}
    order by created_at, id
  `;
  const attachmentRows =
    message.attachmentIds.length === 0
      ? []
      : await sql<{ object_id: string; file_name: string }[]>`
          select object_id, file_name from allrice_message_attachments
          where message_id = ${result.userMessage.id}
        `;
  const attachmentNames = new Map(
    attachmentRows.map((attachment) => [
      attachment.object_id,
      attachment.file_name,
    ]),
  );
  const attachedFiles = await Promise.all(
    message.attachmentIds.map((objectId) => getStoredFile(context, objectId)),
  );
  const imageMediaTypes = new Set<ImageMediaType>([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
  ]);
  const imageAttachments = attachedFiles.flatMap((file) =>
    imageMediaTypes.has(file.object.mediaType as ImageMediaType)
      ? [
          {
            object: file.object as typeof file.object & {
              mediaType: ImageMediaType;
            },
            fileName: attachmentNames.get(file.object.id) ?? 'Attached image',
          },
        ]
      : [],
  );
  const userRequest = attachmentRows.length
    ? `${message.text}\n\nAttached files: ${attachmentRows
        .map((attachment) => attachment.file_name)
        .join(', ')}`
    : message.text;
  try {
    const { prepareEmployeeRunBinding } =
      await import('../employees/employeehub.ts');
    const binding = await prepareEmployeeRunBinding({
      context,
      workspaceId,
      assignmentId: session.employee_assignment_id,
      employeeVersionId: effectiveEmployeeVersionId,
      sessionId: session.id,
      userMessageId: result.userMessage.id,
      assistantMessageId: result.assistantMessage.id,
      promptSnapshot: {
        systemPrompt: '',
        conversation: historyRows.slice(-80).map((row) => ({
          id: row.id,
          role: row.role,
          text: ChatMessageContentSchema.parse(row.content).text,
        })),
        memories,
        userRequest,
        imageAttachments,
      },
    });
    const { enqueueRun, getRun } = await import('../execution/queue.ts');
    if (
      assistantPreference?.allowAssistants &&
      (!assistantRuntimeEnabled() ||
        !binding.executionSnapshot.capabilitySnapshot.bindings.toolNames.includes(
          'assistant.delegate',
        ))
    )
      throw new AssistantRuntimeError('forbidden');
    const queued = await enqueueRun(
      context,
      {
        workspaceId,
        idempotencyKey: `employee-message:${message.clientMessageId}`,
        type: 'allrice.employee.run',
        input: {
          employeeAssignmentId: binding.employeeAssignmentId,
          employeeVersionId: binding.employeeVersionId,
          sessionId: binding.sessionId,
          userMessageId: binding.userMessageId,
          assistantMessageId: binding.assistantMessageId,
          ...(assistantPreference
            ? {
                assistantConfiguration: {
                  ...defaultAssistantRunConfiguration(),
                  allowAssistants: assistantPreference.allowAssistants,
                },
              }
            : {}),
        },
        maxAttempts: 2,
        timeoutMs: binding.executionSnapshot.runtimePolicy.timeoutMs,
      },
      {
        employeeBinding: binding,
        ...(message.reviewContinuation
          ? { reviewContinuation: message.reviewContinuation }
          : {}),
        ...(message.changesetAction
          ? { changesetAction: message.changesetAction }
          : {}),
        conversationDelivery: {
          sessionId: session.id,
          userMessageId: result.userMessage.id,
          assistantMessageId: result.assistantMessage.id,
          clientUserMessageId: message.clientMessageId,
          message: conversationMessage,
          requestedMode: message.deliveryMode,
          ...(message.expectedTurnId
            ? { expectedTurnId: message.expectedTurnId }
            : {}),
          ...(message.expectedGeneration === undefined
            ? {}
            : { expectedGeneration: message.expectedGeneration }),
          hasAttachments: message.attachmentIds.length > 0,
        },
      },
    );
    const responseRun =
      queued.delivery === 'steer_pending' && queued.activeRunId
        ? await getRun(context, workspaceId, queued.activeRunId)
        : queued.run;
    return {
      userMessage: mapMessage(context, result.userMessage, []),
      assistantMessage: mapMessage(context, result.assistantMessage, []),
      run: responseRun,
      fallbackRunId: queued.delivery === 'immediate' ? null : queued.run.id,
      delivery: queued.delivery,
      created: queued.created,
    };
  } catch (error) {
    await sql`
      update allrice_messages
      set content = ${sql.json({
        text: 'Rice 暂时无法开始这次执行，请稍后重试。',
        citations: [],
      })}, status = 'failed', error_code = 'EMPLOYEE_ENQUEUE_FAILED',
        completed_at = now()
      where id = ${result.assistantMessage.id} and status = 'pending'
    `;
    throw error;
  }
}

export async function linkFileToSession(input: {
  context: RequestContext;
  workspaceId: string;
  sessionId: string;
  objectId: string;
  fileName: string;
}) {
  const session = await sessionRow(
    input.context,
    input.workspaceId,
    input.sessionId,
  );
  if (session.owner_id !== requireUser(input.context) || session.archived_at) {
    throw new DataAccessError('authorization_denied');
  }
  const sql = getDatabase();
  const rows = await sql<{ id: string }[]>`
    insert into allrice_file_references (
      organization_id, workspace_id, object_id, session_id, owner_id, file_name
    )
    select
      ${input.context.organizationId}, ${input.workspaceId}, o.id,
      ${session.id}, ${requireUser(input.context)}, ${input.fileName}
    from allrice_storage_objects o
    where o.id = ${UuidSchema.parse(input.objectId)}
      and o.organization_id = ${input.context.organizationId}
      and o.workspace_id = ${input.workspaceId}
      and o.owner_id = ${requireUser(input.context)}
      and o.state = 'ready'
    on conflict (object_id, session_id) do nothing
    returning object_id as id
  `;
  if (!rows[0]) {
    const existing = await sql<{ id: string }[]>`
      select object_id as id from allrice_file_references
      where object_id = ${input.objectId} and session_id = ${session.id}
    `;
    if (!existing[0]) throw new DataAccessError('authorization_denied');
  }
  return { objectId: input.objectId, sessionId: session.id };
}

export async function listWorkspaceFiles(
  context: RequestContext,
  workspaceIdInput: string,
) {
  const workspaceId = await resolveWorkspaceId(context, workspaceIdInput);
  const sql = getDatabase();
  const rows = await sql<
    {
      id: string;
      owner_id: string;
      file_name: string;
      media_type: string;
      size_bytes: number | string;
      visibility: Visibility;
      category: 'uploads' | 'exports';
      deliverable_version: number | null;
      created_at: Date;
    }[]
  >`
    select o.id, o.owner_id,
      coalesce(deliverable.file_name, max(f.file_name), '未命名文件') as file_name,
      o.media_type, o.size_bytes, o.visibility, o.category,
      deliverable.version as deliverable_version, o.created_at
    from allrice_storage_objects o
    left join allrice_file_references f on f.object_id = o.id
    left join lateral (
      select version.file_name, version.version
      from allrice_deliverable_versions version
      where version.object_id = o.id
      order by version.version desc
      limit 1
    ) deliverable on true
    where o.organization_id = ${context.organizationId}
      and o.workspace_id = ${workspaceId}
      and o.category in ('uploads', 'exports') and o.state = 'ready'
      and (o.owner_id = ${requireUser(context)} or o.visibility <> 'private')
    group by o.id, deliverable.file_name, deliverable.version
    order by o.created_at desc
    limit 100
  `;
  return rows.map((row) => ({
    id: row.id,
    fileName: row.file_name,
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes),
    visibility: row.visibility,
    ownedByMe: row.owner_id === requireUser(context),
    category: row.category,
    deliverableVersion: row.deliverable_version,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function linkWorkspaceFileToSession(input: {
  context: RequestContext;
  workspaceId: string;
  sessionId: string;
  objectId: string;
}) {
  const session = await sessionRow(
    input.context,
    input.workspaceId,
    input.sessionId,
  );
  if (session.owner_id !== requireUser(input.context) || session.archived_at) {
    throw new DataAccessError('authorization_denied');
  }
  const sql = getDatabase();
  const rows = await sql<{ id: string; file_name: string }[]>`
    select o.id, coalesce(max(f.file_name), '未命名文件') as file_name
    from allrice_storage_objects o
    left join allrice_file_references f on f.object_id = o.id
    where o.id = ${UuidSchema.parse(input.objectId)}
      and o.organization_id = ${input.context.organizationId}
      and o.workspace_id = ${input.workspaceId}
      and o.state = 'ready'
      and (o.owner_id = ${requireUser(input.context)} or o.visibility <> 'private')
    group by o.id
  `;
  const file = rows[0];
  if (!file) throw new DataAccessError('authorization_denied');
  await sql`
    insert into allrice_file_references (
      organization_id, workspace_id, object_id, session_id, owner_id, file_name
    ) values (
      ${input.context.organizationId}, ${input.workspaceId}, ${file.id},
      ${session.id}, ${requireUser(input.context)}, ${file.file_name}
    ) on conflict (object_id, session_id) do nothing
  `;
  return {
    objectId: file.id,
    sessionId: session.id,
    fileName: file.file_name,
  };
}

function mapMemory(row: MemoryRow): WorkspaceMemory {
  return {
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    employeeId: row.employee_id,
    ownerId: row.owner_id,
    content: row.content,
    visibility: row.visibility,
    sourceType: row.source_type,
    sourceId: row.source_id,
    lifecycleState: row.lifecycle_state,
    memoryClass: row.memory_class,
    revision: row.revision,
    trust: row.trust_level,
    confidence: Number(row.confidence),
    sourceLabel: row.source_label,
    capturedAt: row.captured_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
    lastVerifiedAt: row.last_verified_at?.toISOString() ?? null,
    supersedesMemoryId: row.supersedes_memory_id,
    lastRecalledAt: row.last_recalled_at?.toISOString() ?? null,
    recallCount: row.recall_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listWorkspaceMemories(
  context: RequestContext,
  workspaceIdInput: string,
  employeeIdInput?: string,
) {
  const workspaceId = await resolveWorkspaceId(context, workspaceIdInput);
  const employeeId = employeeIdInput ? UuidSchema.parse(employeeIdInput) : null;
  const sql = getDatabase();
  const rows = await sql<MemoryRow[]>`
    select * from allrice_memories
    where organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId}
      and (${employeeId}::uuid is null or employee_id = ${employeeId})
      and archived_at is null
    order by updated_at desc, id desc
    limit 100
  `;
  return rows
    .filter(
      (row) =>
        authorize(
          {
            type: 'memory',
            id: row.id,
            organizationId: row.organization_id,
            workspaceId: row.workspace_id,
            ownerId: row.owner_id,
            visibility: row.visibility,
            archivedAt: null,
          },
          'resource:read',
          context,
        ).allowed,
    )
    .map(mapMemory);
}

export async function createTraceableMemory(
  context: RequestContext,
  input: unknown,
) {
  const memory = CreateWorkspaceMemoryInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(context, memory.workspaceId);
  const sql = getDatabase();
  if (memory.sourceType === 'user' && memory.sourceId !== null) {
    throw new DataAccessError('authorization_denied');
  }
  if (memory.sourceType === 'message') {
    if (!memory.sourceId) throw new DataAccessError('not_found');
    const messages = await sql<{ id: string }[]>`
      select m.id
      from allrice_messages m
      join allrice_chat_sessions s on s.id = m.session_id
      where m.id = ${memory.sourceId}
        and m.organization_id = ${context.organizationId}
        and m.workspace_id = ${workspaceId}
        and (s.owner_id = ${requireUser(context)} or s.visibility <> 'private')
    `;
    if (!messages[0]) throw new DataAccessError('authorization_denied');
  }
  if (memory.sourceType === 'file') {
    if (!memory.sourceId) throw new DataAccessError('not_found');
    const file = await getStoredFile(context, memory.sourceId);
    if (file.object.workspaceId !== workspaceId) {
      throw new DataAccessError('authorization_denied');
    }
  }
  if (memory.sourceType === 'checkpoint') {
    if (!memory.sourceId) throw new DataAccessError('not_found');
    const checkpoints = await sql<{ id: string }[]>`
      select id from allrice_context_checkpoints
      where id = ${memory.sourceId}
        and organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId}
        and owner_id = ${requireUser(context)}
    `;
    if (!checkpoints[0]) throw new DataAccessError('authorization_denied');
  }
  if (
    (memory.sourceType === 'tool' || memory.sourceType === 'connector') &&
    !memory.sourceId
  ) {
    throw new DataAccessError('not_found');
  }
  if (memory.employeeId) {
    const assignments = await sql<{ id: string }[]>`
      select id from allrice_employee_assignments
      where organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId}
        and employee_id = ${memory.employeeId}
        and user_id = ${requireUser(context)}
        and active
    `;
    if (!assignments[0]) throw new DataAccessError('authorization_denied');
  }
  const created = await createMemory(context, {
    workspaceId,
    employeeId: memory.employeeId,
    projectId: null,
    content: memory.content,
    metadata: {},
    visibility: memory.visibility,
    sourceType: memory.sourceType,
    sourceId: memory.sourceId,
  });
  const trust =
    memory.sourceType === 'user' ||
    (memory.sourceType === 'message' && memory.lifecycleState === 'durable')
      ? 'user_confirmed'
      : memory.sourceType === 'tool' || memory.sourceType === 'connector'
        ? 'untrusted_external'
        : 'derived';
  await sql.begin(async (transaction) => {
    await transaction`
      update allrice_memories
      set trust_level = ${trust}, confidence = ${memory.confidence},
          source_label = ${memory.sourceLabel}, captured_at = now(),
          lifecycle_state = ${memory.lifecycleState},
          memory_class = ${memory.memoryClass},
          expires_at = ${memory.expiresAt},
          last_verified_at = ${trust === 'user_confirmed' ? new Date() : null},
          updated_at = now()
      where id = ${created.id}
        and organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId}
    `;
    await transaction`
      insert into allrice_memory_revisions (
        organization_id, workspace_id, memory_id, revision, content,
        trust_level, lifecycle_state, memory_class, confidence, expires_at,
        reason, changed_by
      ) values (
        ${context.organizationId}, ${workspaceId}, ${created.id}, 1,
        ${memory.content}, ${trust}, ${memory.lifecycleState},
        ${memory.memoryClass}, ${memory.confidence}, ${memory.expiresAt},
        ${`created from ${memory.sourceLabel}`}, ${requireUser(context)}
      )
    `;
  });
  await createRagChunk(context, {
    workspaceId,
    memoryId: created.id,
    content: memory.content,
    embedding: embedWorkspaceText(memory.content),
  });
  const rows = await sql<MemoryRow[]>`
    select * from allrice_memories where id = ${created.id}
  `;
  const row = rows[0];
  if (!row) throw new Error('memory creation failed');
  await audit({
    context,
    workspaceId,
    action: 'memory.create',
    resourceType: 'memory',
    resourceId: row.id,
    reason: `explicit_${memory.sourceType}_source`,
  });
  return mapMemory(row);
}

export async function correctWorkspaceMemory(
  context: RequestContext,
  workspaceIdInput: string,
  memoryIdInput: string,
  input: unknown,
) {
  const correction = CorrectMemoryInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(context, workspaceIdInput);
  const memoryId = UuidSchema.parse(memoryIdInput);
  const sql = getDatabase();
  const row = await sql.begin(async (transaction) => {
    const currentRows = await transaction<MemoryRow[]>`
      select * from allrice_memories
      where id = ${memoryId}
        and organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId}
        and owner_id = ${requireUser(context)}
        and archived_at is null
      for update
    `;
    const current = currentRows[0];
    if (!current) throw new DataAccessError('not_found');
    const governed =
      await transaction`select memory_id from allrice_experience_reviews where memory_id=${current.id}`;
    if (governed.length) throw new DataAccessError('authorization_denied');
    const revision = current.revision + 1;
    const updatedRows = await transaction<MemoryRow[]>`
      update allrice_memories
      set content = ${correction.content}, revision = ${revision},
          trust_level = 'user_confirmed', confidence = ${correction.confidence},
          lifecycle_state = 'durable',
          source_label = '用户更正', expires_at = ${correction.expiresAt},
          last_verified_at = now(), updated_at = now()
      where id = ${current.id}
      returning *
    `;
    await transaction`
      insert into allrice_memory_revisions (
        organization_id, workspace_id, memory_id, revision, content,
        trust_level, lifecycle_state, memory_class, confidence, expires_at,
        reason, changed_by
      ) values (
        ${context.organizationId}, ${workspaceId}, ${current.id}, ${revision},
        ${correction.content}, 'user_confirmed', 'durable',
        ${current.memory_class}, ${correction.confidence},
        ${correction.expiresAt}, ${correction.reason}, ${requireUser(context)}
      )
    `;
    await transaction`
      delete from allrice_rag_chunks
      where organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId}
        and memory_id = ${current.id}
    `;
    const updated = updatedRows[0];
    if (!updated) throw new Error('memory correction failed');
    return updated;
  });
  await createRagChunk(context, {
    workspaceId,
    memoryId: row.id,
    content: correction.content,
    embedding: embedWorkspaceText(correction.content),
  });
  await audit({
    context,
    workspaceId,
    action: 'memory.correct',
    resourceType: 'memory',
    resourceId: row.id,
    reason: correction.reason,
  });
  return mapMemory(row);
}

export async function listWorkspaceMemoryRevisions(
  context: RequestContext,
  workspaceIdInput: string,
  memoryIdInput: string,
) {
  const workspaceId = await resolveWorkspaceId(context, workspaceIdInput);
  const memoryId = UuidSchema.parse(memoryIdInput);
  const sql = getDatabase();
  const memories = await sql<MemoryRow[]>`
    select * from allrice_memories
    where id = ${memoryId}
      and organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId}
  `;
  const memory = memories[0];
  if (!memory) throw new DataAccessError('not_found');
  const allowed = authorize(
    {
      type: 'memory',
      id: memory.id,
      organizationId: memory.organization_id,
      workspaceId: memory.workspace_id,
      ownerId: memory.owner_id,
      visibility: memory.visibility,
      archivedAt: null,
    },
    'resource:read',
    context,
  );
  if (!allowed.allowed) throw new DataAccessError('authorization_denied');
  const rows = await sql<
    {
      id: string;
      organization_id: string;
      workspace_id: string;
      memory_id: string;
      revision: number;
      content: string;
      trust_level:
        | 'user_confirmed'
        | 'platform_verified'
        | 'derived'
        | 'untrusted_external';
      lifecycle_state: MemoryLifecycleState;
      memory_class: MemoryClass;
      confidence: string | number;
      expires_at: Date | null;
      reason: string;
      changed_by: string;
      changed_at: Date;
    }[]
  >`
    select * from allrice_memory_revisions
    where organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId}
      and memory_id = ${memoryId}
    order by revision desc
  `;
  return rows.map((row) =>
    MemoryRevisionSchema.parse({
      id: row.id,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      memoryId: row.memory_id,
      revision: row.revision,
      content: row.content,
      trust: row.trust_level,
      lifecycleState: row.lifecycle_state,
      memoryClass: row.memory_class,
      confidence: Number(row.confidence),
      expiresAt: row.expires_at?.toISOString() ?? null,
      reason: row.reason,
      changedBy: row.changed_by,
      changedAt: row.changed_at.toISOString(),
    }),
  );
}

export async function promoteWorkspaceMemory(
  context: RequestContext,
  workspaceIdInput: string,
  memoryIdInput: string,
) {
  const workspaceId = await resolveWorkspaceId(context, workspaceIdInput);
  const memoryId = UuidSchema.parse(memoryIdInput);
  const sql = getDatabase();
  const result = await sql.begin(async (transaction) => {
    const currentRows = await transaction<MemoryRow[]>`
      select * from allrice_memories
      where id = ${memoryId}
        and organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId}
        and owner_id = ${requireUser(context)}
        and archived_at is null
      for update
    `;
    const current = currentRows[0];
    if (!current) throw new DataAccessError('not_found');
    const governed =
      await transaction`select memory_id from allrice_experience_reviews where memory_id=${current.id}`;
    if (governed.length) throw new DataAccessError('authorization_denied');
    if (current.lifecycle_state === 'durable') {
      return { memory: current, promoted: false };
    }
    const revision = current.revision + 1;
    const updatedRows = await transaction<MemoryRow[]>`
      update allrice_memories
      set lifecycle_state = 'durable', revision = ${revision},
          trust_level = 'user_confirmed',
          confidence = greatest(confidence, 0.8),
          source_label = ${`${current.source_label} · 用户确认`},
          last_verified_at = now(), updated_at = now()
      where id = ${current.id}
      returning *
    `;
    const updated = updatedRows[0];
    if (!updated) throw new Error('memory promotion failed');
    await transaction`
      insert into allrice_memory_revisions (
        organization_id, workspace_id, memory_id, revision, content,
        trust_level, lifecycle_state, memory_class, confidence, expires_at,
        reason, changed_by
      ) values (
        ${context.organizationId}, ${workspaceId}, ${updated.id}, ${revision},
        ${updated.content}, 'user_confirmed', 'durable',
        ${updated.memory_class}, ${updated.confidence}, ${updated.expires_at},
        'candidate promoted by user', ${requireUser(context)}
      )
    `;
    return { memory: updated, promoted: true };
  });
  if (result.promoted) {
    await audit({
      context,
      workspaceId,
      action: 'memory.promote',
      resourceType: 'memory',
      resourceId: result.memory.id,
      reason: 'candidate_promoted_by_owner',
    });
  }
  return mapMemory(result.memory);
}

export async function createCheckpointMemoryCandidate(
  context: RequestContext,
  input: unknown,
) {
  const candidate = CreateCheckpointMemoryCandidateInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(context, candidate.workspaceId);
  const sql = getDatabase();
  const sessions = await sql<{ id: string }[]>`
    select s.id
    from allrice_chat_sessions s
    join allrice_employee_assignments assignment
      on assignment.id = s.employee_assignment_id
     and assignment.organization_id = s.organization_id
     and assignment.workspace_id = s.workspace_id
    where s.id = ${candidate.sessionId}
      and s.organization_id = ${context.organizationId}
      and s.workspace_id = ${workspaceId}
      and s.owner_id = ${requireUser(context)}
      and s.archived_at is null
      and assignment.employee_id = ${candidate.employeeId}
      and assignment.active
  `;
  if (!sessions[0]) throw new DataAccessError('authorization_denied');
  const checkpoints = await sql<{ id: string }[]>`
    select id from allrice_context_checkpoints
    where id = ${candidate.checkpointId}
      and organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId}
      and session_id = ${candidate.sessionId}
      and owner_id = ${requireUser(context)}
  `;
  if (!checkpoints[0]) throw new DataAccessError('authorization_denied');
  const existing = await sql<MemoryRow[]>`
    select * from allrice_memories
    where organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId}
      and source_type = 'checkpoint'
      and source_id = ${candidate.checkpointId}
      and archived_at is null
    limit 1
  `;
  if (existing[0]) return mapMemory(existing[0]);
  return createTraceableMemory(context, {
    workspaceId,
    employeeId: candidate.employeeId,
    content: candidate.content,
    visibility: 'private',
    sourceType: 'checkpoint',
    sourceId: candidate.checkpointId,
    sourceLabel: candidate.sourceLabel,
    lifecycleState: 'candidate',
    memoryClass: 'work_note',
    confidence: 0.7,
    expiresAt: null,
  });
}

export async function deleteWorkspaceMemory(
  context: RequestContext,
  workspaceId: string,
  memoryId: string,
) {
  const sql = getDatabase();
  const memory = await sql.begin(async (transaction) => {
    const rows = await transaction<MemoryRow[]>`
      update allrice_memories
      set archived_at = now(), updated_at = now()
      where id = ${UuidSchema.parse(memoryId)}
        and organization_id = ${context.organizationId}
        and workspace_id = ${UuidSchema.parse(workspaceId)}
        and owner_id = ${requireUser(context)}
        and archived_at is null
      returning *
    `;
    const row = rows[0];
    if (!row) throw new DataAccessError('not_found');
    await transaction`
      delete from allrice_rag_chunks
      where organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId}
        and memory_id = ${row.id}
    `;
    return row;
  });
  await audit({
    context,
    workspaceId,
    action: 'memory.delete',
    resourceType: 'memory',
    resourceId: memory.id,
    reason: 'resource_owner',
  });
}

export async function getEmployeeWorkspace(
  context: RequestContext,
  requestedWorkspaceId?: string,
) {
  const assignment = await ensureDefaultEmployee(context, requestedWorkspaceId);
  const [sessions, memories] = await Promise.all([
    listChatSessions(context, assignment.workspaceId, {
      includeArchived: true,
    }),
    listWorkspaceMemories(context, assignment.workspaceId),
  ]);
  const { listEmployeeHub } = await import('../employees/employeehub.ts');
  const employeeHub = await listEmployeeHub(context, assignment.workspaceId);
  const assignedEmployeeIds = [
    ...new Set(employeeHub.assignments.map((item) => item.employeeId)),
  ];
  const sessionIds = sessions.sessions.map((session) => session.id);
  const sql = getDatabase();
  const employeeSkillRows =
    assignedEmployeeIds.length === 0
      ? []
      : await sql<
          {
            employee_id: string;
            id: string;
            name: string;
            description: string;
          }[]
        >`
          select binding.employee_id, skill.id, skill.name, skill.description
          from allrice_employee_dsh_skill_bindings binding
          join allrice_dsh_skills skill
            on skill.organization_id = binding.organization_id
           and skill.workspace_id = binding.workspace_id
           and skill.id = binding.skill_id
          where binding.organization_id = ${context.organizationId}
            and binding.workspace_id = ${assignment.workspaceId}
            and binding.employee_id in ${sql(assignedEmployeeIds)}
            and binding.enabled and skill.enabled
          order by binding.employee_id, skill.name, skill.id
        `;
  const skillsByEmployee = new Map<
    string,
    Array<{ id: string; name: string; description: string }>
  >();
  for (const skill of employeeSkillRows) {
    const skills = skillsByEmployee.get(skill.employee_id) ?? [];
    skills.push({
      id: skill.id,
      name: skill.name,
      description: skill.description,
    });
    skillsByEmployee.set(skill.employee_id, skills);
  }
  const modelRows =
    sessionIds.length === 0
      ? []
      : await sql<{ session_id: string; snapshot: unknown }[]>`
          select session_id, snapshot
          from allrice_session_model_snapshots
          where organization_id = ${context.organizationId}
            and workspace_id = ${assignment.workspaceId}
            and session_id in ${sql(sessionIds)}
        `;
  const sessionModels = modelRows.flatMap((row) => {
    const parsed = SessionModelSnapshotSchema.safeParse(row.snapshot);
    if (!parsed.success) return [];
    const snapshot = parsed.data;
    return [
      {
        sessionId: row.session_id,
        // Legacy snapshots are readable, but the public SaaS runtime is DSH.
        harness: 'dsh' as const,
        provider:
          snapshot.provider === 'codex' ? 'openai-codex' : snapshot.provider,
        model: snapshot.model,
        reasoningEffort: snapshot.reasoningEffort,
      },
    ];
  });
  return {
    organizationId: context.organizationId,
    workspaceId: assignment.workspaceId,
    employee: assignment,
    employees: employeeHub.assignments,
    employeeProfiles: employeeHub.assignments.map((item) => {
      const manifest = item.currentVersion.manifest;
      const identity =
        manifest.schemaVersion === 2
          ? manifest.identity
          : {
              role: manifest.partnerProfile.role,
              mission: manifest.partnerProfile.mission,
              workStyle: manifest.description,
              behaviorRules: [] as string[],
              safetyBoundaries: [] as string[],
            };
      const runtimePolicy =
        manifest.schemaVersion === 2
          ? manifest.runtimePolicy
          : {
              harness: 'dsh' as const,
              provider: manifest.provider.provider,
              model: manifest.provider.model,
              reasoningEffort: manifest.provider.reasoningEffort,
            };
      return {
        assignmentId: item.id,
        employeeId: item.employeeId,
        name: manifest.name,
        description: manifest.description,
        identity,
        skills: skillsByEmployee.get(item.employeeId) ?? [],
        model: {
          harness: 'dsh' as const,
          provider: runtimePolicy.provider,
          model: runtimePolicy.model,
          reasoningEffort: runtimePolicy.reasoningEffort,
        },
      };
    }),
    sessions: sessions.sessions,
    sessionModels,
    memories,
  };
}
