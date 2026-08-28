import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  BridgeCommandPayloadSchema,
  BridgeCommandSchema,
  BridgeDeviceSchema,
  BridgeFolderGrantSchema,
  CompleteBridgeCommandInputSchema,
  CreateBridgeFolderGrantInputSchema,
  CreateBridgePairingInputSchema,
  PairBridgeDeviceInputSchema,
  UuidSchema,
  type BridgeCapability,
  type BridgeCommand,
  type BridgeCommandPayload,
  type BridgeDevice,
  type BridgeFolderGrant,
  type ExecutionContext,
  type RequestContext,
} from '@allrice/contracts';

import { DataAccessError } from './data.ts';
import { getDatabase } from './index.ts';

const onlineWindowSeconds = 90;
const maximumResultBytes = 500_000;
type JsonValue = Parameters<ReturnType<typeof getDatabase>['json']>[0];

function toJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  return serialized === undefined
    ? null
    : (JSON.parse(serialized) as JsonValue);
}

interface DeviceRow {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  name: string;
  platform: 'macos-arm64';
  protocol_version: number;
  capabilities: BridgeCapability[];
  last_seen_at: Date | null;
  created_at: Date;
  revoked_at: Date | null;
}

interface GrantRow {
  id: string;
  device_id: string;
  label: string;
  root_fingerprint: string;
  created_at: Date;
  revoked_at: Date | null;
}

interface CommandRow {
  id: string;
  device_id: string;
  folder_grant_id: string;
  capability: BridgeCapability;
  arguments: Record<string, unknown>;
  status: BridgeCommand['status'];
  lease_token: string | null;
  created_at: Date;
  timeout_at: Date;
  result: unknown | null;
  summary: string | null;
  error_code: string | null;
}

interface AuthenticatedDeviceRow extends DeviceRow {
  token_hash: string;
}

export class BridgeDataError extends Error {
  constructor(
    public readonly code:
      | 'pairing_invalid'
      | 'device_unauthorized'
      | 'device_offline'
      | 'grant_missing'
      | 'command_unavailable'
      | 'lease_lost'
      | 'result_too_large',
  ) {
    super(code);
  }
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizePairingCode(value: string) {
  const compact = value.replaceAll('-', '').toUpperCase();
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function actorId(context: RequestContext) {
  if (context.actor.type !== 'user') {
    throw new DataAccessError('authentication_required');
  }
  return context.actor.id;
}

function requireWorkspaceMember(context: RequestContext, workspaceId: string) {
  const userId = actorId(context);
  const allowed = context.memberships.some(
    (membership) =>
      membership.active &&
      membership.userId === userId &&
      membership.organizationId === context.organizationId &&
      (membership.workspaceId === null ||
        membership.workspaceId === workspaceId),
  );
  if (!allowed) throw new DataAccessError('authorization_denied');
  return userId;
}

function mapDevice(row: DeviceRow, now = Date.now()): BridgeDevice {
  const status = row.revoked_at
    ? 'revoked'
    : row.last_seen_at &&
        now - row.last_seen_at.getTime() <= onlineWindowSeconds * 1_000
      ? 'online'
      : 'offline';
  return BridgeDeviceSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    name: row.name,
    platform: row.platform,
    protocolVersion: row.protocol_version,
    capabilities: row.capabilities,
    status,
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
  });
}

function mapGrant(row: GrantRow): BridgeFolderGrant {
  return BridgeFolderGrantSchema.parse({
    id: row.id,
    deviceId: row.device_id,
    label: row.label,
    rootFingerprint: row.root_fingerprint,
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
  });
}

function mapCommand(row: CommandRow): BridgeCommand {
  if (!row.lease_token) throw new BridgeDataError('lease_lost');
  return BridgeCommandSchema.parse({
    id: row.id,
    deviceId: row.device_id,
    folderGrantId: row.folder_grant_id,
    status: row.status,
    payload: { capability: row.capability, arguments: row.arguments },
    leaseToken: row.lease_token,
    createdAt: row.created_at.toISOString(),
    timeoutAt: row.timeout_at.toISOString(),
  });
}

async function audit(input: {
  organizationId: string;
  workspaceId: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  decision?: 'allowed' | 'denied' | 'recorded';
  reason: string;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const sql = getDatabase();
  await sql`
    insert into allrice_audit_events (
      organization_id, workspace_id, actor_id, action, resource_type,
      resource_id, decision, reason, request_id, metadata
    ) values (
      ${input.organizationId}, ${input.workspaceId}, ${input.actorId},
      ${input.action}, ${input.resourceType}, ${input.resourceId ?? null},
      ${input.decision ?? 'recorded'}, ${input.reason},
      ${input.requestId ?? null}, ${sql.json(toJsonValue(input.metadata ?? {}))}
    )
  `;
}

async function authenticatedDevice(token: string) {
  if (!token || token.length > 256) {
    throw new BridgeDataError('device_unauthorized');
  }
  const sql = getDatabase();
  const rows = await sql<AuthenticatedDeviceRow[]>`
    select id, organization_id, workspace_id, owner_id, name, platform,
      protocol_version, capabilities, token_hash, last_seen_at, created_at,
      revoked_at
    from allrice_bridge_devices
    where token_hash = ${sha256(token)} and revoked_at is null limit 1
  `;
  const row = rows[0];
  if (!row) throw new BridgeDataError('device_unauthorized');
  return row;
}

export async function createBridgePairing(
  context: RequestContext,
  input: unknown,
) {
  const parsed = CreateBridgePairingInputSchema.parse(input);
  const ownerId = requireWorkspaceMember(context, parsed.workspaceId);
  const compact = randomBytes(4).toString('hex').toUpperCase();
  const code = `${compact.slice(0, 4)}-${compact.slice(4)}`;
  const id = randomUUID();
  const sql = getDatabase();
  const rows = await sql<{ expires_at: Date }[]>`
    insert into allrice_bridge_pairing_codes (
      id, organization_id, workspace_id, owner_id, device_name,
      code_hash, expires_at
    ) values (
      ${id}, ${context.organizationId}, ${parsed.workspaceId}, ${ownerId},
      ${parsed.deviceName}, ${sha256(code)}, now() + interval '10 minutes'
    ) returning expires_at
  `;
  await audit({
    organizationId: context.organizationId,
    workspaceId: parsed.workspaceId,
    actorId: ownerId,
    action: 'bridge.pairing.create',
    resourceType: 'bridge_pairing',
    resourceId: id,
    reason: 'workspace_member',
    requestId: context.requestId,
  });
  return {
    id,
    code,
    deviceName: parsed.deviceName,
    expiresAt: rows[0]!.expires_at.toISOString(),
  };
}

export async function pairBridgeDevice(input: unknown) {
  const parsed = PairBridgeDeviceInputSchema.parse(input);
  const code = normalizePairingCode(parsed.code);
  const token = `rb_${randomBytes(32).toString('base64url')}`;
  const sql = getDatabase();
  const device = await sql.begin(async (transaction) => {
    const pairings = await transaction<
      {
        id: string;
        organization_id: string;
        workspace_id: string;
        owner_id: string;
      }[]
    >`
      select id, organization_id, workspace_id, owner_id
      from allrice_bridge_pairing_codes
      where code_hash = ${sha256(code)} and used_at is null
        and expires_at > now()
      for update
    `;
    const pairing = pairings[0];
    if (!pairing) throw new BridgeDataError('pairing_invalid');
    const rows = await transaction<DeviceRow[]>`
      insert into allrice_bridge_devices (
        organization_id, workspace_id, owner_id, name, platform,
        protocol_version, capabilities, token_hash, last_seen_at
      ) values (
        ${pairing.organization_id}, ${pairing.workspace_id},
        ${pairing.owner_id}, ${parsed.name}, ${parsed.platform},
        ${parsed.protocolVersion}, ${parsed.capabilities}, ${sha256(token)}, now()
      ) returning id, organization_id, workspace_id, owner_id, name,
        platform, protocol_version, capabilities, last_seen_at, created_at,
        revoked_at
    `;
    const row = rows[0]!;
    await transaction`
      update allrice_bridge_pairing_codes
      set used_at = now(), device_id = ${row.id}
      where id = ${pairing.id}
    `;
    return row;
  });
  await audit({
    organizationId: device.organization_id,
    workspaceId: device.workspace_id,
    actorId: device.owner_id,
    action: 'bridge.device.pair',
    resourceType: 'bridge_device',
    resourceId: device.id,
    reason: 'one_time_pairing_code',
    metadata: { platform: device.platform },
  });
  return { device: mapDevice(device), deviceToken: token };
}

export async function listBridgeDevices(
  context: RequestContext,
  workspaceIdInput: string,
) {
  const workspaceId = UuidSchema.parse(workspaceIdInput);
  const ownerId = requireWorkspaceMember(context, workspaceId);
  const sql = getDatabase();
  const rows = await sql<DeviceRow[]>`
    select id, organization_id, workspace_id, owner_id, name, platform,
      protocol_version, capabilities, last_seen_at, created_at, revoked_at
    from allrice_bridge_devices
    where organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId} and owner_id = ${ownerId}
      and revoked_at is null
    order by last_seen_at desc nulls last, created_at desc
  `;
  if (rows.length === 0) return [];
  const grants = await sql<GrantRow[]>`
    select id, device_id, label, root_fingerprint, created_at, revoked_at
    from allrice_bridge_folder_grants
    where device_id in ${sql(rows.map((row) => row.id))}
      and revoked_at is null
    order by created_at
  `;
  const grantsByDevice = new Map<string, BridgeFolderGrant[]>();
  for (const row of grants) {
    const current = grantsByDevice.get(row.device_id) ?? [];
    current.push(mapGrant(row));
    grantsByDevice.set(row.device_id, current);
  }
  return rows.map((row) => ({
    ...mapDevice(row),
    folderGrants: grantsByDevice.get(row.id) ?? [],
  }));
}

export async function heartbeatBridgeDevice(token: string) {
  const device = await authenticatedDevice(token);
  const sql = getDatabase();
  const rows = await sql<DeviceRow[]>`
    update allrice_bridge_devices set last_seen_at = now(), updated_at = now()
    where id = ${device.id} and revoked_at is null
    returning id, organization_id, workspace_id, owner_id, name, platform,
      protocol_version, capabilities, last_seen_at, created_at, revoked_at
  `;
  return mapDevice(rows[0]!);
}

export async function bridgeDeviceStatus(token: string) {
  const device = await authenticatedDevice(token);
  const sql = getDatabase();
  const grants = await sql<GrantRow[]>`
    select id, device_id, label, root_fingerprint, created_at, revoked_at
    from allrice_bridge_folder_grants
    where device_id = ${device.id} and revoked_at is null order by created_at
  `;
  return { device: mapDevice(device), grants: grants.map(mapGrant) };
}

export async function revokeCurrentBridgeDevice(token: string) {
  const device = await authenticatedDevice(token);
  const sql = getDatabase();
  await sql.begin(async (transaction) => {
    await transaction`
      update allrice_bridge_devices set revoked_at = now(), updated_at = now()
      where id = ${device.id} and revoked_at is null
    `;
    await transaction`
      update allrice_bridge_folder_grants set revoked_at = now()
      where device_id = ${device.id} and revoked_at is null
    `;
    await transaction`
      update allrice_bridge_commands
      set status = 'canceled', completed_at = now(), updated_at = now(),
        error_code = 'device_revoked'
      where device_id = ${device.id}
        and status in ('queued', 'claimed', 'running')
    `;
  });
  await audit({
    organizationId: device.organization_id,
    workspaceId: device.workspace_id,
    actorId: device.owner_id,
    action: 'bridge.device.revoke',
    resourceType: 'bridge_device',
    resourceId: device.id,
    reason: 'device_self_revoke',
  });
}

export async function createBridgeFolderGrant(token: string, input: unknown) {
  const device = await authenticatedDevice(token);
  const parsed = CreateBridgeFolderGrantInputSchema.parse(input);
  const sql = getDatabase();
  const rows = await sql<GrantRow[]>`
    insert into allrice_bridge_folder_grants (
      organization_id, workspace_id, owner_id, device_id, label,
      root_fingerprint
    ) values (
      ${device.organization_id}, ${device.workspace_id}, ${device.owner_id},
      ${device.id}, ${parsed.label}, ${parsed.rootFingerprint}
    ) on conflict (device_id, root_fingerprint) do update set
      label = excluded.label, revoked_at = null
    returning id, device_id, label, root_fingerprint, created_at, revoked_at
  `;
  const grant = rows[0]!;
  await audit({
    organizationId: device.organization_id,
    workspaceId: device.workspace_id,
    actorId: device.owner_id,
    action: 'bridge.folder_grant.create',
    resourceType: 'bridge_folder_grant',
    resourceId: grant.id,
    reason: 'device_owner_confirmed_local_root',
    metadata: { deviceId: device.id, label: grant.label },
  });
  return mapGrant(grant);
}

export async function revokeBridgeDevice(
  context: RequestContext,
  workspaceIdInput: string,
  deviceIdInput: string,
) {
  const workspaceId = UuidSchema.parse(workspaceIdInput);
  const deviceId = UuidSchema.parse(deviceIdInput);
  const ownerId = requireWorkspaceMember(context, workspaceId);
  const sql = getDatabase();
  const rows = await sql<{ id: string }[]>`
    update allrice_bridge_devices set revoked_at = now(), updated_at = now()
    where id = ${deviceId} and organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId} and owner_id = ${ownerId}
      and revoked_at is null returning id
  `;
  if (!rows[0]) throw new DataAccessError('not_found');
  await sql`
    update allrice_bridge_folder_grants set revoked_at = now()
    where device_id = ${deviceId} and revoked_at is null
  `;
  await sql`
    update allrice_bridge_commands
    set status = 'canceled', completed_at = now(), updated_at = now(),
      error_code = 'device_revoked'
    where device_id = ${deviceId} and status in ('queued', 'claimed', 'running')
  `;
  await audit({
    organizationId: context.organizationId,
    workspaceId,
    actorId: ownerId,
    action: 'bridge.device.revoke',
    resourceType: 'bridge_device',
    resourceId: deviceId,
    reason: 'device_owner',
    requestId: context.requestId,
  });
}

export async function revokeBridgeFolderGrant(
  context: RequestContext,
  workspaceIdInput: string,
  grantIdInput: string,
) {
  const workspaceId = UuidSchema.parse(workspaceIdInput);
  const grantId = UuidSchema.parse(grantIdInput);
  const ownerId = requireWorkspaceMember(context, workspaceId);
  const sql = getDatabase();
  const grant = await sql.begin(async (transaction) => {
    const rows = await transaction<
      { id: string; device_id: string; label: string }[]
    >`
      update allrice_bridge_folder_grants folder_grant set revoked_at = now()
      from allrice_bridge_devices device
      where folder_grant.id = ${grantId}
        and folder_grant.device_id = device.id
        and folder_grant.organization_id = ${context.organizationId}
        and folder_grant.workspace_id = ${workspaceId}
        and folder_grant.owner_id = ${ownerId}
        and device.organization_id = ${context.organizationId}
        and device.workspace_id = ${workspaceId}
        and device.owner_id = ${ownerId}
        and device.revoked_at is null
        and folder_grant.revoked_at is null
      returning folder_grant.id, folder_grant.device_id, folder_grant.label
    `;
    const row = rows[0];
    if (!row) throw new DataAccessError('not_found');
    await transaction`
      update allrice_bridge_commands
      set status = 'canceled', completed_at = now(), updated_at = now(),
        error_code = 'folder_grant_revoked'
      where folder_grant_id = ${grantId}
        and status in ('queued', 'claimed', 'running')
    `;
    return row;
  });
  await audit({
    organizationId: context.organizationId,
    workspaceId,
    actorId: ownerId,
    action: 'bridge.folder_grant.revoke',
    resourceType: 'bridge_folder_grant',
    resourceId: grantId,
    reason: 'workspace_owner_disconnected_local_root',
    requestId: context.requestId,
    metadata: { deviceId: grant.device_id, label: grant.label },
  });
}

export async function claimNextBridgeCommand(token: string) {
  const device = await authenticatedDevice(token);
  const leaseToken = randomUUID();
  const sql = getDatabase();
  const command = await sql.begin(async (transaction) => {
    await transaction`
      update allrice_bridge_commands
      set status = 'expired', completed_at = now(), updated_at = now(),
        error_code = 'command_timeout'
      where device_id = ${device.id} and status = 'queued'
        and timeout_at <= now()
    `;
    const rows = await transaction<CommandRow[]>`
      with candidate as (
        select id from allrice_bridge_commands
        where device_id = ${device.id} and status = 'queued'
          and timeout_at > now()
        order by created_at for update skip locked limit 1
      )
      update allrice_bridge_commands command
      set status = 'claimed', lease_token = ${leaseToken},
        claimed_at = now(), updated_at = now()
      from candidate where command.id = candidate.id
      returning command.id, command.device_id, command.folder_grant_id,
        command.capability, command.arguments, command.status,
        command.lease_token, command.created_at, command.timeout_at,
        command.result, command.summary, command.error_code
    `;
    await transaction`
      update allrice_bridge_devices set last_seen_at = now(), updated_at = now()
      where id = ${device.id}
    `;
    return rows[0] ?? null;
  });
  return command ? mapCommand(command) : null;
}

export async function completeBridgeCommand(
  token: string,
  commandIdInput: string,
  input: unknown,
) {
  const device = await authenticatedDevice(token);
  const commandId = UuidSchema.parse(commandIdInput);
  const parsed = CompleteBridgeCommandInputSchema.parse(input);
  const serialized = JSON.stringify(parsed.output ?? null);
  if (Buffer.byteLength(serialized) > maximumResultBytes) {
    throw new BridgeDataError('result_too_large');
  }
  const sql = getDatabase();
  const rows = await sql<CommandRow[]>`
    update allrice_bridge_commands set
      status = ${parsed.status}, result = ${sql.json(toJsonValue(parsed.output ?? null))},
      summary = ${parsed.summary}, error_code = ${parsed.errorCode ?? null},
      completed_at = now(), updated_at = now()
    where id = ${commandId} and device_id = ${device.id}
      and lease_token = ${parsed.leaseToken}
      and status in ('claimed', 'running') and timeout_at > now()
    returning id, device_id, folder_grant_id, capability, arguments, status,
      lease_token, created_at, timeout_at, result, summary, error_code
  `;
  const row = rows[0];
  if (!row) throw new BridgeDataError('lease_lost');
  await audit({
    organizationId: device.organization_id,
    workspaceId: device.workspace_id,
    actorId: device.owner_id,
    action: 'bridge.command.complete',
    resourceType: 'bridge_command',
    resourceId: commandId,
    decision: parsed.status === 'succeeded' ? 'allowed' : 'denied',
    reason: parsed.errorCode ?? 'local_read_only_execution',
    metadata: { deviceId: device.id, capability: row.capability },
  });
  return { status: row.status };
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function dispatchBridgeCommand(input: {
  context: ExecutionContext;
  payload: BridgeCommandPayload;
  idempotencyKey: string;
  timeoutMs?: number;
}) {
  const payload = BridgeCommandPayloadSchema.parse(input.payload);
  const workspaceId = input.context.workspaceId;
  if (!workspaceId) throw new BridgeDataError('device_offline');
  const ownerId = input.context.policySnapshot.subjectId;
  const timeoutMs = Math.min(
    Math.max(input.timeoutMs ?? 30_000, 5_000),
    60_000,
  );
  const sql = getDatabase();
  const targets = await sql<{ device_id: string; grant_id: string }[]>`
    select d.id as device_id, g.id as grant_id
    from allrice_bridge_devices d
    join lateral (
      select id from allrice_bridge_folder_grants
      where device_id = d.id and revoked_at is null
      order by created_at limit 1
    ) g on true
    where d.organization_id = ${input.context.organizationId}
      and d.workspace_id = ${workspaceId} and d.owner_id = ${ownerId}
      and d.revoked_at is null
      and d.last_seen_at > now() - (${onlineWindowSeconds} * interval '1 second')
      and ${payload.capability} = any(d.capabilities)
    order by d.last_seen_at desc limit 1
  `;
  const target = targets[0];
  if (!target) throw new BridgeDataError('device_offline');
  const rows = await sql<{ id: string }[]>`
    insert into allrice_bridge_commands (
      organization_id, workspace_id, owner_id, device_id, folder_grant_id,
      capability, arguments, idempotency_key, timeout_at
    ) values (
      ${input.context.organizationId}, ${workspaceId}, ${ownerId},
      ${target.device_id}, ${target.grant_id}, ${payload.capability},
      ${sql.json(toJsonValue(payload.arguments))}, ${input.idempotencyKey.slice(0, 255)},
      now() + (${timeoutMs} * interval '1 millisecond')
    ) on conflict (organization_id, idempotency_key) do update set
      updated_at = allrice_bridge_commands.updated_at
    returning id
  `;
  const commandId = rows[0]!.id;
  await sql`select pg_notify('allrice_bridge_commands', ${target.device_id})`;
  await audit({
    organizationId: input.context.organizationId,
    workspaceId,
    actorId: ownerId,
    action: 'bridge.command.enqueue',
    resourceType: 'bridge_command',
    resourceId: commandId,
    reason: 'tool_broker_authorized',
    metadata: { capability: payload.capability, deviceId: target.device_id },
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const commands = await sql<CommandRow[]>`
      select id, device_id, folder_grant_id, capability, arguments, status,
        lease_token, created_at, timeout_at, result, summary, error_code
      from allrice_bridge_commands where id = ${commandId}
    `;
    const command = commands[0];
    if (!command) throw new BridgeDataError('command_unavailable');
    if (command.status === 'succeeded') {
      return {
        output: command.result,
        summary: command.summary ?? `已在本地执行 ${command.capability}`,
      };
    }
    if (['failed', 'expired', 'canceled'].includes(command.status)) {
      throw new BridgeDataError('command_unavailable');
    }
    await sleep(250);
  }
  await sql`
    update allrice_bridge_commands
    set status = 'expired', completed_at = now(), updated_at = now(),
      error_code = 'broker_wait_timeout'
    where id = ${commandId} and status in ('queued', 'claimed', 'running')
  `;
  throw new BridgeDataError('command_unavailable');
}
