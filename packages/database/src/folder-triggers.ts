import { createHash, randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import {
  FolderTriggerConfigSchema,
  FolderTriggerEventSchema,
  FolderTriggerObservationSchema,
  FolderTriggerRuleSchema,
  LocalFilePayloadSchema,
  MembershipSchema,
  UuidSchema,
  localFileMediaType,
  type FolderTriggerConfig,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { bridgeDeviceStatus } from './bridge.ts';
import { bridgeCapabilityReadinessView } from './bridge-settings.ts';
import { DataAccessError, getStoredFile, markStorageReady } from './data.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import { readWorkAutomation, getWorkAutomation } from './work-automation.ts';
import { lockWorkspaceStorageQuota } from './core/storage-quota.ts';
import {
  enqueueLocalFileCommand,
  readLocalFileCommand,
} from './local-files.ts';
import {
  createChatSession,
  sendChatMessage,
  linkFileToSession,
} from './workspace/service.ts';

type EventRow = {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  automation_id: string;
  revision: number;
  device_id: string;
  folder_grant_id: string;
  folder_grant_version: number;
  path: string;
  expected: unknown;
  request_digest: string;
  reserved_session_id: string;
  session_id: string | null;
  command_id: string | null;
  object_id: string | null;
  run_id: string | null;
  state: string;
  observed_at: Date;
  created_at: Date;
  name: string;
  prompt: string;
  employee_assignment_id: string;
  folder: unknown;
  current_revision: number;
  status: string;
  deleted_at: Date | null;
};
type Scope = { organizationId: string; workspaceId: string; ownerId: string };
class FolderTriggerDeferredError extends DataAccessError {
  constructor() {
    super('authorization_denied');
  }
}

/** Rules, automatic original-byte import and task enqueue share current owner
 * authority. Device tokens select scope; they never become a tenant actor. */
async function authority(
  tx: TransactionSql,
  scope: Scope,
  folder: FolderTriggerConfig,
  assignmentId: string,
  allowBusy = false,
) {
  const members =
    await tx`select m.id,m.user_id as "userId",m.organization_id as "organizationId",m.workspace_id as "workspaceId",m.role,m.active
    from allrice_memberships m join allrice_users u on u.id=m.user_id and u.status='active'
    join allrice_organizations o on o.id=m.organization_id and o.archived_at is null
    join allrice_workspaces w on w.id=${scope.workspaceId} and w.organization_id=m.organization_id and w.archived_at is null
    where m.user_id=${scope.ownerId} and m.organization_id=${scope.organizationId} and m.active and m.role in ('admin','member')
      and (m.workspace_id is null or m.workspace_id=${scope.workspaceId}) for share of m,u,o,w`;
  if (!members.length) throw new DataAccessError('authorization_denied');
  const settings = await readWorkAutomation(tx, {
    ...scope,
    userId: scope.ownerId,
  });
  if (!settings.available || !settings.settings.computer)
    throw new DataAccessError('authorization_denied');
  const [assignment] =
    await tx`select a.id from allrice_employee_assignments a join allrice_employee_versions v on v.id=a.employee_version_id
    where a.id=${assignmentId} and a.organization_id=${scope.organizationId} and a.workspace_id=${scope.workspaceId} and a.user_id=${scope.ownerId} and a.active
      and v.provider_snapshot->>'provider' in ('codex','dsh')
      and not exists(select 1 from allrice_platform_employee_tenant_assignments p where p.organization_id=a.organization_id and p.workspace_id=a.workspace_id and p.tenant_employee_id=a.employee_id and not p.active)
    for share of a,v`;
  // Explicit statements fix row-lock order regardless of the join planner.
  // Heartbeat also takes target before device; revocation takes device/grant
  // before commands. Never hold a device while waiting for the target.
  const [target] = await tx<
    { metadata: Record<string, unknown>; state: string }[]
  >`select metadata,state from allrice_execution_targets
    where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and target_key=${'bridge.' + folder.deviceId} and kind='rice_bridge'
      and metadata->'environment'->>'folderTriggerVersion'='1' for share`;
  const [device] = await tx<
    { last_seen_at: Date | null }[]
  >`select last_seen_at from allrice_bridge_devices
    where id=${folder.deviceId} and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId}
      and revoked_at is null and capabilities @> array['local.file.import']::text[] for share`;
  const [grant] =
    await tx`select id from allrice_bridge_folder_grants where id=${folder.folderGrantId} and device_id=${folder.deviceId}
    and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId}
    and revoked_at is null and runtime_generation=${folder.folderGrantVersion} for share`;
  if (!assignment || !target || !device || !grant)
    throw new DataAccessError('authorization_denied');
  if (
    !device.last_seen_at ||
    device.last_seen_at.getTime() <= Date.now() - 90_000 ||
    device.last_seen_at.getTime() > Date.now() ||
    target.state !== 'online' ||
    !['ready', ...(allowBusy ? ['busy'] : [])].includes(
      bridgeCapabilityReadinessView(target.metadata, 'local.file.import').state,
    )
  )
    throw new FolderTriggerDeferredError();
  return {
    requestId: randomUUID(),
    sessionId: folder.deviceId,
    actor: { type: 'user', id: scope.ownerId },
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    memberships: MembershipSchema.array().parse(members),
    authenticatedAt: new Date().toISOString(),
  } satisfies RequestContext;
}
export async function validateFolderTriggerConfiguration(
  context: RequestContext,
  raw: unknown,
  assignmentId: string,
  tx?: TransactionSql,
) {
  if (context.actor.type !== 'user' || !context.workspaceId)
    throw new DataAccessError('authorization_denied');
  const folder = FolderTriggerConfigSchema.parse(raw),
    scope = {
      organizationId: context.organizationId,
      workspaceId: context.workspaceId,
      ownerId: context.actor.id,
    };
  const verify = (sql: TransactionSql) =>
    authority(sql, scope, folder, UuidSchema.parse(assignmentId));
  return tx ? verify(tx) : getDatabase().begin(verify);
}
async function readEvent(tx: TransactionSql, id: string) {
  const [row] = await tx<
    EventRow[]
  >`select e.*,a.name,a.prompt,a.employee_assignment_id,a.folder,a.revision as current_revision,a.status,a.deleted_at
    from allrice_automation_folder_events e join allrice_automations a on a.id=e.automation_id where e.id=${UuidSchema.parse(id)} for share of e,a`;
  if (!row) throw new DataAccessError('not_found');
  return row;
}
export async function assertFolderTriggerEventAuthority(
  tx: TransactionSql,
  id: string,
  scope?: Scope,
) {
  const row = await readEvent(tx, id),
    folder = FolderTriggerConfigSchema.parse(row.folder);
  if (
    row.status !== 'enabled' ||
    row.deleted_at ||
    row.revision !== row.current_revision ||
    folder.deviceId !== row.device_id ||
    folder.folderGrantId !== row.folder_grant_id ||
    folder.folderGrantVersion !== row.folder_grant_version ||
    (scope &&
      (scope.organizationId !== row.organization_id ||
        scope.workspaceId !== row.workspace_id ||
        scope.ownerId !== row.owner_id))
  )
    throw new DataAccessError('authorization_denied');
  const context = await authority(
    tx,
    {
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      ownerId: row.owner_id,
    },
    folder,
    row.employee_assignment_id,
    true,
  );
  return { row, context, folder };
}
export async function assertFolderTriggerMessage(
  tx: TransactionSql,
  id: string,
  context: RequestContext,
  sessionId: string,
  clientMessageId: string,
  attachmentIds: string[],
) {
  const { row } = await assertFolderTriggerEventAuthority(tx, id, {
    organizationId: context.organizationId,
    workspaceId: context.workspaceId!,
    ownerId: context.actor.id,
  });
  if (
    row.id !== clientMessageId ||
    row.reserved_session_id !== sessionId ||
    row.session_id !== sessionId ||
    !row.object_id ||
    attachmentIds.length !== 1 ||
    attachmentIds[0] !== row.object_id ||
    row.state !== 'import_pending'
  )
    throw new DataAccessError('authorization_denied');
}
export async function readFolderTriggerRules(token: string) {
  const { device } = await bridgeDeviceStatus(token),
    db = getDatabase();
  const rows = await db<
    {
      id: string;
      folder: unknown;
      revision: number;
      employee_assignment_id: string;
    }[]
  >`select id,folder,revision,employee_assignment_id from allrice_automations
    where organization_id=${device.organizationId} and workspace_id=${device.workspaceId} and owner_id=${device.ownerId} and trigger_type='folder' and status='enabled' and deleted_at is null and folder->>'deviceId'=${device.id} order by created_at limit 32`;
  const rules = [];
  for (const row of rows) {
    const folder = FolderTriggerConfigSchema.parse(row.folder);
    try {
      await db.begin((tx) =>
        authority(
          tx,
          {
            organizationId: device.organizationId,
            workspaceId: device.workspaceId,
            ownerId: device.ownerId,
          },
          folder,
          row.employee_assignment_id,
          true,
        ),
      );
    } catch (e) {
      if (
        e instanceof DataAccessError ||
        e instanceof FolderTriggerDeferredError
      )
        continue;
      throw e;
    }
    const config = {
      deviceId: folder.deviceId,
      folderGrantId: folder.folderGrantId,
      folderGrantVersion: folder.folderGrantVersion,
      relativePath: folder.relativePath,
      extensions: folder.extensions,
      ignorePaths: folder.ignorePaths,
    };
    rules.push(
      FolderTriggerRuleSchema.parse({
        ...config,
        automationId: row.id,
        revision: row.revision,
        admissionExpiresAt: new Date(Date.now() + 75_000).toISOString(),
      }),
    );
  }
  return { rules };
}
export function folderTriggerMatches(
  folder: FolderTriggerConfig,
  path: string,
) {
  const normalized = path.normalize('NFC').toLowerCase(),
    relative = folder.relativePath.normalize('NFC').toLowerCase();
  if (relative !== '.' && !normalized.startsWith(relative + '/')) return false;
  if (
    path
      .split('/')
      .some(
        (p) =>
          p.startsWith('.') ||
          p.startsWith('~$') ||
          p.endsWith('.part') ||
          p.endsWith('.tmp'),
      )
  )
    return false;
  if (
    folder.ignorePaths.some((p) => {
      p = p.normalize('NFC').toLowerCase();
      return normalized === p || normalized.startsWith(p + '/');
    })
  )
    return false;
  return folder.extensions.includes(
    normalized.split('.').at(-1) as FolderTriggerConfig['extensions'][number],
  );
}
export async function receiveFolderTriggerEvent(token: string, raw: unknown) {
  const event = FolderTriggerEventSchema.parse(raw),
    { device } = await bridgeDeviceStatus(token),
    db = getDatabase(),
    digest = runtimePolicyDigest(event);
  return db.begin(async (tx) => {
    const [existing] = await tx<
      { id: string; request_digest: string; state: string }[]
    >`select id,request_digest,state from allrice_automation_folder_events where id=${event.eventId}
      and organization_id=${device.organizationId} and workspace_id=${device.workspaceId} and owner_id=${device.ownerId} and device_id=${device.id}`;
    if (existing) {
      if (existing.request_digest !== digest)
        throw new DataAccessError('grant_invalid');
      return {
        acceptedEventId: event.eventId,
        eventId: existing.id,
        state: existing.state,
      };
    }
    const [rule] = await tx<
      {
        id: string;
        folder: unknown;
        revision: number;
        employee_assignment_id: string;
      }[]
    >`select id,folder,revision,employee_assignment_id from allrice_automations where id=${event.ruleId}
      and organization_id=${device.organizationId} and workspace_id=${device.workspaceId} and owner_id=${device.ownerId} and trigger_type='folder' and status='enabled' and deleted_at is null for update`;
    if (!rule) throw new DataAccessError('authorization_denied');
    const folder = FolderTriggerConfigSchema.parse(rule.folder);
    if (
      rule.revision !== event.revision ||
      folder.deviceId !== device.id ||
      folder.folderGrantId !== event.grantId ||
      folder.folderGrantVersion !== event.grantVersion ||
      !folderTriggerMatches(folder, event.path) ||
      event.expected.mediaType !== localFileMediaType(event.path) ||
      Date.parse(event.observedAt) > Date.now() + 60_000
    )
      throw new DataAccessError('grant_invalid');
    await authority(
      tx,
      {
        organizationId: device.organizationId,
        workspaceId: device.workspaceId,
        ownerId: device.ownerId,
      },
      folder,
      rule.employee_assignment_id,
      true,
    );
    const [duplicate] = await tx<
      { id: string; state: string }[]
    >`select id,state from allrice_automation_folder_events where device_id=${device.id} and automation_id=${rule.id} and revision=${rule.revision} and path=${event.path} and expected->>'version'=${event.expected.version} and expected->>'checksum'=${event.expected.checksum}`;
    if (duplicate)
      return {
        acceptedEventId: event.eventId,
        eventId: duplicate.id,
        state: duplicate.state,
      };
    const [count] = await tx<
      { n: number }[]
    >`select count(*)::int as n from allrice_automation_folder_events where owner_id=${device.ownerId} and workspace_id=${device.workspaceId} and state in ('received','import_pending')`;
    if (!count || count.n >= 2000) throw new DataAccessError('quota_exceeded');
    const empty = event.expected.sizeBytes === 0;
    await tx`insert into allrice_automation_folder_events(id,organization_id,workspace_id,owner_id,automation_id,revision,device_id,folder_grant_id,folder_grant_version,path,expected,request_digest,observed_at,reserved_session_id,state,error_code)
      values(${event.eventId},${device.organizationId},${device.workspaceId},${device.ownerId},${rule.id},${event.revision},${device.id},${event.grantId},${event.grantVersion},${event.path},${tx.json(event.expected)},${digest},${event.observedAt},${randomUUID()},${empty ? 'blocked' : 'received'},${empty ? 'EMPTY_INPUT' : null})`;
    return {
      acceptedEventId: event.eventId,
      eventId: event.eventId,
      state: empty ? 'blocked' : 'received',
    };
  });
}
export async function recordFolderTriggerObservation(
  token: string,
  raw: unknown,
) {
  const observation = FolderTriggerObservationSchema.parse(raw),
    { device } = await bridgeDeviceStatus(token),
    db = getDatabase();
  await db.begin(async (tx) => {
    const [rule] =
      await tx`select id from allrice_automations where id=${observation.ruleId} and organization_id=${device.organizationId} and workspace_id=${device.workspaceId} and owner_id=${device.ownerId}
      and trigger_type='folder' and revision=${observation.revision} and folder->>'deviceId'=${device.id} and deleted_at is null for share`;
    if (!rule) throw new DataAccessError('authorization_denied');
    await tx`insert into allrice_folder_trigger_observations(automation_id,revision,device_id,status,error_code)values(${observation.ruleId},${observation.revision},${device.id},${observation.status},${observation.errorCode})
      on conflict(automation_id)do update set revision=excluded.revision,device_id=excluded.device_id,status=excluded.status,error_code=excluded.error_code,observed_at=clock_timestamp()`;
  });
  return { recorded: true };
}
/** Only original automatic imports gain this extra commit gate; manual imports
 * keep their existing semantics. Quota is acquired before command/rule locks. */
export async function commitFolderTriggerFileUpload(input: {
  token: string;
  commandId: string;
  leaseToken: string;
  objectId: string;
  fileName: string;
  markReady?: boolean;
}) {
  const { device } = await bridgeDeviceStatus(input.token),
    db = getDatabase();
  return db.begin(async (tx) => {
    await lockWorkspaceStorageQuota(
      tx,
      device.organizationId,
      device.workspaceId,
    );
    // Match the immutable event binding without locking the command first.
    // Revocation takes device/grant -> command; freeze current rule and device
    // authority before taking the command lock, avoiding the inverse order.
    const [bound] = await tx<
      { folder_event_id: string | null }[]
    >`select folder_event_id from allrice_bridge_commands where id=${input.commandId} and device_id=${device.id} and owner_id=${device.ownerId} and organization_id=${device.organizationId} and workspace_id=${device.workspaceId}`;
    if (!bound?.folder_event_id)
      throw new DataAccessError('authorization_denied');
    const { row, context } = await assertFolderTriggerEventAuthority(
      tx,
      bound.folder_event_id,
      {
        organizationId: device.organizationId,
        workspaceId: device.workspaceId,
        ownerId: device.ownerId,
      },
    );
    const [command] = await tx<
      { folder_event_id: string; arguments: unknown; session_id: string }[]
    >`select folder_event_id,arguments,session_id from allrice_bridge_commands where id=${input.commandId}
      and device_id=${device.id} and owner_id=${device.ownerId} and organization_id=${device.organizationId} and workspace_id=${device.workspaceId} and lease_token=${input.leaseToken}
      and status in ('claimed','running') and cancel_requested_at is null and timeout_at>clock_timestamp() for update`;
    if (!command?.folder_event_id)
      throw new DataAccessError('authorization_denied');
    const payload = LocalFilePayloadSchema.parse({
      capability: 'local.file.import',
      arguments: command.arguments,
    });
    if (
      payload.capability !== 'local.file.import' ||
      payload.arguments.object.objectId !== input.objectId ||
      payload.arguments.object.fileName !== input.fileName ||
      payload.arguments.path !== row.path ||
      command.session_id !== row.reserved_session_id ||
      runtimePolicyDigest(payload.arguments.expected) !==
        runtimePolicyDigest(row.expected)
    )
      throw new DataAccessError('grant_invalid');
    // Token replacement wins before ready as well as at stream admission.
    const [current] =
      await tx`select id from allrice_bridge_devices where id=${device.id} and revoked_at is null and token_hash=${createHash('sha256').update(input.token).digest('hex')} for share`;
    if (!current) throw new DataAccessError('authorization_denied');
    const [stored] =
      await tx`select id from allrice_storage_objects where id=${input.objectId} and organization_id=${device.organizationId} and workspace_id=${device.workspaceId} and owner_id=${device.ownerId} and checksum=${payload.arguments.object.checksum} and size_bytes=${payload.arguments.object.sizeBytes} and media_type=${payload.arguments.object.mediaType} and state=${input.markReady === false ? 'ready' : 'pending'} for share`;
    if (!stored) throw new DataAccessError('grant_invalid');
    if (input.markReady !== false)
      await markStorageReady(context, input.objectId, tx);
    await linkFileToSession({
      context,
      workspaceId: device.workspaceId,
      sessionId: command.session_id,
      objectId: input.objectId,
      fileName: input.fileName,
      database: tx,
    });
    const [live] =
      await tx`select id from allrice_bridge_commands where id=${input.commandId} and status in ('claimed','running') and cancel_requested_at is null and timeout_at>clock_timestamp()`;
    if (!live) throw new DataAccessError('authorization_denied');
  });
}
async function rememberQueuedEvent(
  tx: TransactionSql,
  row: EventRow,
  runId: string,
) {
  await tx`insert into allrice_automation_runs(id,organization_id,workspace_id,automation_id,run_id,session_id,status,scheduled_for,folder_event_id)
    values(${row.id},${row.organization_id},${row.workspace_id},${row.automation_id},${runId},${row.reserved_session_id},'queued',${row.created_at},${row.id}) on conflict(folder_event_id) where folder_event_id is not null do nothing`;
  await tx`update allrice_automation_folder_events set run_id=${runId},state='queued',recovery_lease_until=null,updated_at=clock_timestamp() where id=${row.id}`;
}
/** Adoption records an already committed Run even if the rule was subsequently
 * paused. It never renews authority, imports bytes or starts a model. */
async function adoptQueuedEvent(id: string) {
  return getDatabase().begin(async (tx) => {
    const row = await readEvent(tx, id);
    const [existing] = await tx<
      { run_id: string }[]
    >`select r.run_id from allrice_messages u
      join allrice_messages a on a.reply_to_id=u.id and a.session_id=u.session_id and a.role='assistant'
      join allrice_employee_runs r on r.assistant_message_id=a.id and r.organization_id=u.organization_id and r.workspace_id=u.workspace_id
      where u.organization_id=${row.organization_id} and u.workspace_id=${row.workspace_id} and u.owner_id=${row.owner_id}
        and u.session_id=${row.reserved_session_id} and u.role='user' and u.client_message_id=${row.id}`;
    if (!existing) return false;
    await rememberQueuedEvent(tx, row, existing.run_id);
    return true;
  });
}
async function processEvent(id: string) {
  const db = getDatabase();
  if (await adoptQueuedEvent(id)) return;
  const { row, context } = await db.begin((tx) =>
    assertFolderTriggerEventAuthority(tx, id),
  );
  if (row.state === 'queued' || row.state === 'blocked') return;
  await createChatSession(
    context,
    {
      workspaceId: row.workspace_id,
      employeeAssignmentId: row.employee_assignment_id,
      title: `自动处理 · ${row.name} · ${row.path.split('/').at(-1)}`.slice(
        0,
        160,
      ),
    },
    { sessionId: row.reserved_session_id },
  );
  const command = await enqueueLocalFileCommand(
    context,
    {
      workspaceId: row.workspace_id,
      deviceId: row.device_id,
      folderGrantId: row.folder_grant_id,
      idempotencyKey: row.id,
      sessionId: row.reserved_session_id,
      action: 'import',
      path: row.path,
      expected: row.expected,
    },
    { folderEventId: row.id },
  );
  await db`update allrice_automation_folder_events set command_id=${command.id},session_id=${row.reserved_session_id},state='import_pending',updated_at=clock_timestamp() where id=${row.id} and state='received'`;
  const current = await readLocalFileCommand(
    context,
    row.workspace_id,
    command.id,
  );
  if (['failed', 'expired', 'canceled', 'unknown'].includes(current.status))
    throw new DataAccessError('grant_invalid');
  if (current.status !== 'succeeded') return;
  const [storedCommand] = await db<
    { arguments: unknown }[]
  >`select arguments from allrice_bridge_commands where id=${command.id} and folder_event_id=${row.id}`;
  const payload = LocalFilePayloadSchema.parse({
    capability: 'local.file.import',
    arguments: storedCommand?.arguments,
  });
  if (payload.capability !== 'local.file.import')
    throw new DataAccessError('grant_invalid');
  const original = await getStoredFile(
    context,
    payload.arguments.object.objectId,
  );
  if (
    original.object.checksum !== payload.arguments.expected.checksum ||
    original.object.sizeBytes !== payload.arguments.expected.sizeBytes ||
    original.object.mediaType !== payload.arguments.expected.mediaType
  )
    throw new DataAccessError('grant_invalid');
  await db`update allrice_automation_folder_events set object_id=${original.object.id} where id=${row.id} and state='import_pending'`;
  const result = await sendChatMessage(
    context,
    row.workspace_id,
    row.reserved_session_id,
    {
      clientMessageId: row.id,
      text: `${row.prompt}\n\n文件夹规则「${row.name}」检测到新文件版本「${row.path}」。附件是已校验的真实原文件。请直接处理附件并交付结果。不要覆写原文件或向监听输入目录写回成果；成果通过平台文件交付。`,
      attachmentIds: [original.object.id],
    },
    { folderEventId: row.id },
  );
  await db.begin((tx) => rememberQueuedEvent(tx, row, result.run.id));
}
/** Called by the original Automation tick. Durable import IDs and message IDs
 * recover lost ACKs; none of these retries repeat a model execution. */
export async function processFolderTriggerEvents(limit = 4) {
  const db = getDatabase();
  const rows = await db<
    { id: string }[]
  >`with candidate as(select id from allrice_automation_folder_events where state in ('received','import_pending') and (recovery_lease_until is null or recovery_lease_until<clock_timestamp()) order by created_at for update skip locked limit ${Math.min(16, Math.max(1, limit))})
    update allrice_automation_folder_events e set recovery_lease_until=clock_timestamp()+interval '90 seconds' from candidate c where e.id=c.id returning e.id`;
  for (const { id } of rows) {
    try {
      await processEvent(id);
    } catch (e) {
      if (await adoptQueuedEvent(id)) continue;
      if (e instanceof FolderTriggerDeferredError)
        await db`update allrice_automation_folder_events set error_code='WAITING_FOR_COMPUTER',error_message='等待电脑恢复就绪；尚未启动任务。',updated_at=clock_timestamp() where id=${id} and state<>'queued'`;
      else if (e instanceof DataAccessError)
        await db`update allrice_automation_folder_events set state='blocked',error_code='FOLDER_INPUT_UNAVAILABLE',error_message='规则、权限或原文件已变化；没有重新启动任务。',updated_at=clock_timestamp() where id=${id} and state<>'queued'`;
      else throw e;
    } finally {
      await db`update allrice_automation_folder_events set recovery_lease_until=null where id=${id}`;
    }
  }
  return rows.length;
}
export async function listFolderTriggerHistory(
  context: RequestContext,
  workspaceId: string,
  automationId: string,
) {
  const db = getDatabase();
  const [rule] =
    await db`select id,status,revision from allrice_automations where id=${UuidSchema.parse(automationId)} and organization_id=${context.organizationId} and workspace_id=${UuidSchema.parse(workspaceId)} and owner_id=${context.actor.id} and trigger_type='folder' and deleted_at is null`;
  if (context.actor.type !== 'user' || !rule)
    throw new DataAccessError('authorization_denied');
  const observations =
    await db`select status,error_code as "errorCode",observed_at as "observedAt" from allrice_folder_trigger_observations where automation_id=${rule.id} and revision=${rule.revision}`;
  const events =
    await db`select e.id,e.path,e.state,e.error_code as "errorCode",e.error_message as "errorMessage",e.observed_at as "observedAt",e.session_id as "sessionId",e.run_id as "runId",r.state as "runStatus"
    from allrice_automation_folder_events e left join allrice_runs r on r.id=e.run_id where e.automation_id=${rule.id} and e.owner_id=${context.actor.id} order by e.created_at desc limit 20`;
  return { observation: observations[0] ?? null, events };
}

export async function folderTriggerOptions(
  context: RequestContext,
  workspaceId: string,
) {
  workspaceId = UuidSchema.parse(workspaceId);
  const work = await getWorkAutomation(context, workspaceId),
    db = getDatabase();
  const devices = await db<
    {
      id: string;
      name: string;
      metadata: Record<string, unknown>;
      last_seen_at: Date | null;
      state: string;
      grants: { id: string; label: string; version: number }[];
    }[]
  >`select d.id,d.name,t.metadata,d.last_seen_at,t.state,
    coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'label',g.label,'version',g.runtime_generation) order by g.created_at) from allrice_bridge_folder_grants g where g.device_id=d.id and g.revoked_at is null),'[]'::jsonb) as grants
    from allrice_bridge_devices d left join allrice_execution_targets t on t.target_key='bridge.'||d.id::text and t.organization_id=d.organization_id and t.workspace_id=d.workspace_id
    where d.organization_id=${context.organizationId} and d.workspace_id=${workspaceId} and d.owner_id=${context.actor.id} and d.revoked_at is null order by d.created_at limit 32`;
  const employees = await db<
    { id: string; name: string }[]
  >`select a.id,v.name from allrice_employee_assignments a join allrice_employee_versions v on v.id=a.employee_version_id where a.organization_id=${context.organizationId} and a.workspace_id=${workspaceId} and a.user_id=${context.actor.id} and a.active and v.provider_snapshot->>'provider' in ('dsh','codex')
    and not exists(select 1 from allrice_platform_employee_tenant_assignments p where p.organization_id=a.organization_id and p.workspace_id=a.workspace_id and p.tenant_employee_id=a.employee_id and not p.active) order by v.name`;
  return {
    workspaceId,
    editable: work.editable && work.settings.computer,
    employees,
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      grants: d.grants,
      ready:
        !!d.last_seen_at &&
        d.last_seen_at.getTime() > Date.now() - 90_000 &&
        d.state === 'online' &&
        !!d.metadata &&
        (d.metadata.environment as Record<string, unknown> | undefined)
          ?.folderTriggerVersion === 1 &&
        bridgeCapabilityReadinessView(d.metadata, 'local.file.import').state ===
          'ready',
    })),
  };
}
