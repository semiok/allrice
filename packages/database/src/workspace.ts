import { createHash } from 'node:crypto';

import {
  ChatMessageContentSchema,
  CreateChatSessionInputSchema,
  CreateWorkspaceMemoryInputSchema,
  EmployeeManifestSchema,
  SendChatMessageInputSchema,
  UpdateChatSessionInputSchema,
  UuidSchema,
  authorize,
  type ChatMessageSchema,
  type ChatSessionSchema,
  type EmployeeAssignmentSchema,
  type RequestContext,
  type Visibility,
  type WorkspaceMemorySchema,
} from '@allrice/contracts';
import { z } from 'zod';

import {
  DataAccessError,
  createMemory,
  createRagChunk,
  getStoredFile,
} from './data.ts';
import { getDatabase } from './index.ts';
import {
  builtInEmployeeManifests,
  employeeManifestChecksum,
  employeeManifestTemplateChecksum,
  riceEmployeeKey,
  riceManifest,
} from './employee-config.ts';

// Bump when the built-in Rice prompt contract changes so existing assignments
// receive the new version while historical Sessions remain pinned.
const riceVersion = 8;

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
  client_message_id: string | null;
  reply_to_id: string | null;
  created_at: Date;
  completed_at: Date | null;
  run_id?: string | null;
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
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
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
    for (const builtIn of builtInEmployeeManifests()) {
      const builtInEmployees = await transaction<{ id: string }[]>`
        insert into allrice_employees (
          organization_id, workspace_id, employee_key, name
        ) values (
          ${context.organizationId}, ${workspaceId}, ${builtIn.key}, ${builtIn.name}
        )
        on conflict (organization_id, workspace_id, employee_key)
        do update set name = excluded.name, updated_at = now()
        returning id
      `;
      const builtInEmployeeId = builtInEmployees[0]?.id;
      if (!builtInEmployeeId)
        throw new Error('built-in employee provisioning failed');
      const currentBuiltInVersions = await transaction<
        {
          id: string;
          version: number;
          config_checksum: string;
          manifest: unknown;
        }[]
      >`
        select id, version, config_checksum, manifest
        from allrice_employee_versions
        where employee_id = ${builtInEmployeeId}
        order by version desc
        limit 1
      `;
      let builtInVersionId = currentBuiltInVersions[0]?.id;
      if (!builtInVersionId) {
        const builtInChecksum = employeeManifestChecksum(builtIn);
        const insertedVersions = await transaction<{ id: string }[]>`
          insert into allrice_employee_versions (
            organization_id, workspace_id, employee_id, version, name, model,
            system_prompt, capabilities, config_checksum, description, manifest,
            provider_snapshot, skill_version_ids
          ) values (
            ${context.organizationId}, ${workspaceId}, ${builtInEmployeeId}, 1,
            ${builtIn.name}, ${builtIn.provider.model}, ${builtIn.systemPrompt},
            ${transaction.json(builtIn.capabilities)}, ${builtInChecksum},
            ${builtIn.description}, ${transaction.json(builtIn)},
            ${transaction.json(builtIn.provider)},
            ${transaction.json(builtIn.skillVersionIds)}
          ) returning id
        `;
        builtInVersionId = insertedVersions[0]?.id;
      } else {
        const currentManifest = EmployeeManifestSchema.safeParse(
          currentBuiltInVersions[0]?.manifest,
        );
        const templateChanged =
          !currentManifest.success ||
          employeeManifestTemplateChecksum(currentManifest.data) !==
            employeeManifestTemplateChecksum(builtIn);
        if (templateChanged) {
          const skillVersionIds = currentManifest.success
            ? currentManifest.data.skillVersionIds
            : builtIn.skillVersionIds;
          const nextManifest = EmployeeManifestSchema.parse(
            builtIn.schemaVersion === 2
              ? {
                  ...builtIn,
                  skillVersionIds,
                  capabilityBindings: {
                    ...builtIn.capabilityBindings,
                    skillVersionIds,
                  },
                }
              : { ...builtIn, skillVersionIds },
          );
          const nextChecksum = employeeManifestChecksum(nextManifest);
          const nextVersions = await transaction<{ version: number }[]>`
            select coalesce(max(version), 0)::integer + 1 as version
            from allrice_employee_versions
            where employee_id = ${builtInEmployeeId}
          `;
          const insertedVersions = await transaction<{ id: string }[]>`
            insert into allrice_employee_versions (
              organization_id, workspace_id, employee_id, version, name, model,
              system_prompt, capabilities, config_checksum, description, manifest,
              provider_snapshot, skill_version_ids
            ) values (
              ${context.organizationId}, ${workspaceId}, ${builtInEmployeeId},
              ${nextVersions[0]?.version ?? 1}, ${builtIn.name},
              ${nextManifest.provider.model}, ${nextManifest.systemPrompt},
              ${transaction.json(nextManifest.capabilities)}, ${nextChecksum},
              ${nextManifest.description}, ${transaction.json(nextManifest)},
              ${transaction.json(nextManifest.provider)},
              ${transaction.json(nextManifest.skillVersionIds)}
            ) returning id
          `;
          builtInVersionId = insertedVersions[0]?.id;
        }
      }
      if (!builtInVersionId)
        throw new Error('built-in employee version missing');
      await transaction`
        update allrice_employee_assignments
        set employee_version_id = ${builtInVersionId}, updated_at = now()
        where organization_id = ${context.organizationId}
          and workspace_id = ${workspaceId}
          and employee_id = ${builtInEmployeeId}
          and active
      `;
    }
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
  const employeeVersionId = parsed.employeeVersionId
    ? UuidSchema.parse(parsed.employeeVersionId)
    : assignment.employeeVersionId;
  const versions = await sql<{ id: string }[]>`
    select id from allrice_employee_versions
    where id = ${employeeVersionId}
      and organization_id = ${context.organizationId}
      and workspace_id = ${defaultAssignment.workspaceId}
      and employee_id = ${assignment.employeeId}
      and provider_snapshot ->> 'provider' = 'codex'
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
  return {
    id: row.id,
    sessionId: row.session_id,
    ownerId: row.owner_id,
    role: row.role,
    content: ChatMessageContentSchema.parse(row.content),
    status: row.status,
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
    select m.*, er.run_id
    from allrice_messages m
    left join allrice_employee_runs er on er.assistant_message_id = m.id
    where m.organization_id = ${context.organizationId}
      and m.workspace_id = ${workspaceId}
      and m.session_id = ${row.id}
    order by
      m.created_at,
      case when m.role = 'user' then 0 else 1 end,
      m.id
  `;
  const attachments = await messageAttachments(
    messages.map((message) => message.id),
  );
  return {
    session: mapSession(row),
    messages: messages.map((message) =>
      mapMessage(context, message, attachments.get(message.id) ?? []),
    ),
  };
}

export function embedWorkspaceText(text: string) {
  const dimensions = 1536;
  const vector = Array.from({ length: dimensions }, () => 0);
  const tokens = text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [text];
  for (const token of tokens) {
    const digest = createHash('sha256').update(token).digest();
    for (let offset = 0; offset < 24; offset += 4) {
      const value = digest.readUInt32BE(offset);
      const index = value % dimensions;
      vector[index] = (vector[index] ?? 0) + (value & 1 ? 1 : -1);
    }
  }
  const magnitude = Math.sqrt(
    vector.reduce((sum, value) => sum + value * value, 0),
  );
  return magnitude === 0 ? vector : vector.map((value) => value / magnitude);
}

function vectorLiteral(values: number[]) {
  return `[${values.join(',')}]`;
}

async function recallForReply(
  context: RequestContext,
  workspaceId: string,
  employeeId: string | undefined,
  text: string,
) {
  const sql = getDatabase();
  const employeeScope = employeeId ?? null;
  const embedding = vectorLiteral(embedWorkspaceText(text));
  return await sql<{ id: string; content: string }[]>`
    select m.id, m.content
    from allrice_rag_chunks c
    join allrice_memories m on m.id = c.memory_id
    where c.organization_id = ${context.organizationId}
      and c.workspace_id = ${workspaceId}
      and m.archived_at is null
      and (${employeeScope}::uuid is null or m.employee_id is null or m.employee_id = ${employeeScope})
      and (c.owner_id = ${requireUser(context)} or c.visibility <> 'private')
    order by c.embedding <=> ${embedding}::vector
    limit 3
  `;
}

export async function searchWorkspaceMemories(
  context: RequestContext,
  input: { workspaceId: string; query: string; limit?: number },
) {
  const workspaceId = await resolveWorkspaceId(context, input.workspaceId);
  const query = z.string().trim().min(1).max(4_000).parse(input.query);
  const limit = z.number().int().min(1).max(20).default(5).parse(input.limit);
  const sql = getDatabase();
  const embedding = vectorLiteral(embedWorkspaceText(query));
  return sql<
    {
      id: string;
      content: string;
      source_type: string;
      source_id: string | null;
    }[]
  >`
    select m.id, m.content, m.source_type, m.source_id
    from allrice_rag_chunks c
    join allrice_memories m on m.id = c.memory_id
    where c.organization_id = ${context.organizationId}
      and c.workspace_id = ${workspaceId}
      and m.archived_at is null
      and (c.owner_id = ${requireUser(context)} or c.visibility <> 'private')
    order by c.embedding <=> ${embedding}::vector
    limit ${limit}
  `;
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
  const session = await sessionRow(context, workspaceId, sessionId);
  if (session.owner_id !== requireUser(context) || session.archived_at) {
    throw new DataAccessError('authorization_denied');
  }
  const sql = getDatabase();
  const employeeRows = await sql<{ employee_id: string }[]>`
    select employee_id from allrice_employee_assignments
    where id = ${session.employee_assignment_id}
      and organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId}
  `;
  const memories = await recallForReply(
    context,
    workspaceId,
    employeeRows[0]?.employee_id,
    message.text,
  );
  const result = await sql.begin(async (transaction) => {
    await transaction`
      select pg_advisory_xact_lock(
        hashtextextended(${`${session.id}:${message.clientMessageId}`}, 50)
      )
    `;
    const existing = await transaction<MessageRow[]>`
      select * from allrice_messages
      where session_id = ${session.id}
        and owner_id = ${requireUser(context)}
        and client_message_id = ${message.clientMessageId}
    `;
    let userMessage = existing[0];
    if (!userMessage) {
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
          ${transaction.json({ text: message.text, citations: [] })},
          ${session.visibility}, ${message.clientMessageId}, 'completed', now()
        )
        returning *
      `;
      userMessage = users[0];
      if (!userMessage) throw new Error('user message creation failed');
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
    const { getRun } = await import('./queue.ts');
    return {
      userMessage: mapMessage(context, result.userMessage, []),
      assistantMessage: mapMessage(context, result.assistantMessage, []),
      run: await getRun(context, workspaceId, existingEmployeeRuns[0].run_id),
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
      : await sql<{ file_name: string }[]>`
          select file_name from allrice_message_attachments
          where message_id = ${result.userMessage.id}
          order by file_name
        `;
  const userRequest = attachmentRows.length
    ? `${message.text}\n\nAttached files: ${attachmentRows
        .map((attachment) => attachment.file_name)
        .join(', ')}`
    : message.text;
  try {
    const { prepareEmployeeRunBinding } = await import('./employeehub.ts');
    const binding = await prepareEmployeeRunBinding({
      context,
      workspaceId,
      assignmentId: session.employee_assignment_id,
      employeeVersionId: session.employee_version_id,
      sessionId: session.id,
      userMessageId: result.userMessage.id,
      assistantMessageId: result.assistantMessage.id,
      promptSnapshot: {
        systemPrompt: '',
        conversation: historyRows.slice(-80).map((row) => ({
          role: row.role,
          text: ChatMessageContentSchema.parse(row.content).text,
        })),
        memories,
        userRequest,
      },
    });
    const { enqueueRun } = await import('./queue.ts');
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
        },
        maxAttempts: 2,
        timeoutMs: 300_000,
      },
      { employeeBinding: binding },
    );
    return {
      userMessage: mapMessage(context, result.userMessage, []),
      assistantMessage: mapMessage(context, result.assistantMessage, []),
      run: queued.run,
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
      created_at: Date;
    }[]
  >`
    select o.id, o.owner_id,
      coalesce(max(f.file_name), '未命名文件') as file_name,
      o.media_type, o.size_bytes, o.visibility, o.created_at
    from allrice_storage_objects o
    left join allrice_file_references f on f.object_id = o.id
    where o.organization_id = ${context.organizationId}
      and o.workspace_id = ${workspaceId}
      and o.category = 'uploads' and o.state = 'ready'
      and (o.owner_id = ${requireUser(context)} or o.visibility <> 'private')
    group by o.id
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
  const { listEmployeeHub } = await import('./employeehub.ts');
  const employeeHub = await listEmployeeHub(context, assignment.workspaceId);
  return {
    organizationId: context.organizationId,
    workspaceId: assignment.workspaceId,
    employee: assignment,
    employees: employeeHub.assignments,
    sessions: sessions.sessions,
    memories,
  };
}
