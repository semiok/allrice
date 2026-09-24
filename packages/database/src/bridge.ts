import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { preparePairedBrowserGrant } from './local-browser-grants.ts';

import {
  BridgeCommandPayloadSchema,
  BridgeCommandSchema,
  BridgeDeviceSchema,
  BridgeFolderGrantSchema,
  HeartbeatBridgeDeviceInputSchema,
  BridgeWorkspaceSelectionRequestSchema,
  CompleteBridgeCommandInputSchema,
  CompleteBridgeWorkspaceSelectionInputSchema,
  CreateBridgeFolderGrantInputSchema,
  CreateBridgePairingInputSchema,
  PairBridgeDeviceInputSchema,
  UuidSchema,
  type BridgeEnvironment,
  type BridgeCapability,
  type BridgeCommand,
  type BridgeCommandPayload,
  type BridgeDevice,
  type BridgeFolderGrant,
  type BridgeWorkspaceSelectionRequest,
  type ExecutionContext,
  type RequestContext,
} from '@allrice/contracts';

import { DataAccessError } from './data.ts';
import { getDatabase } from './core/client.ts';
import {
  requireTenantManagementScope,
  type TenantManagementTarget,
} from './tenant-management-scope.ts';

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
  platform: 'macos-arm64' | 'macos-x64';
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

interface WorkspaceSelectionRow {
  id: string;
  device_id: string;
  status: BridgeWorkspaceSelectionRequest['status'];
  lease_token: string | null;
  requested_at: Date;
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
        row.last_seen_at.getTime() <= now &&
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

function executionTargetCapabilities(capabilities: BridgeCapability[]) {
  return [
    ...(capabilities.some((item) => item.startsWith('local.fs.'))
      ? (['files.read'] as const)
      : []),
    ...(capabilities.some((item) =>
      ['local.fs.write', 'local.fs.mkdir'].includes(item),
    )
      ? (['files.write'] as const)
      : []),
    ...(capabilities.some((item) => item.startsWith('local.git.'))
      ? (['git.read'] as const)
      : []),
  ];
}

async function syncBridgeExecutionTarget(
  device: DeviceRow,
  state: 'online' | 'offline' | 'revoked',
  sql: ReturnType<typeof getDatabase> | postgres.TransactionSql = getDatabase(),
  environment?: BridgeEnvironment,
) {
  await sql`
    insert into allrice_execution_targets (
      organization_id, workspace_id, target_key, kind, label, state,
      capabilities, concurrency_limit, timeout_seconds, last_heartbeat_at,
      unavailable_reason, metadata
    ) values (
      ${device.organization_id}, ${device.workspace_id},
      ${`bridge.${device.id}`}, 'rice_bridge', ${device.name}, ${state},
      ${sql.json(executionTargetCapabilities(device.capabilities))}, 1, 120,
      ${state === 'online' ? device.last_seen_at : null},
      ${state === 'online' ? null : `bridge_${state}`},
      ${sql.json({
        bridgeDeviceId: device.id,
        platform: device.platform,
        protocolVersion: device.protocol_version,
        environment: environment ?? null,
      })}
    ) on conflict (organization_id, workspace_id, target_key) do update set
      label = excluded.label, state = excluded.state,
      capabilities = excluded.capabilities,
      last_heartbeat_at = excluded.last_heartbeat_at,
      unavailable_reason = excluded.unavailable_reason,
      metadata = allrice_execution_targets.metadata || excluded.metadata, updated_at = now()
  `;
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

function mapWorkspaceSelection(
  row: WorkspaceSelectionRow,
): BridgeWorkspaceSelectionRequest {
  if (!row.lease_token) throw new BridgeDataError('lease_lost');
  return BridgeWorkspaceSelectionRequestSchema.parse({
    id: row.id,
    deviceId: row.device_id,
    status: row.status,
    leaseToken: row.lease_token,
    requestedAt: row.requested_at.toISOString(),
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
  const result = await sql.begin(async (transaction) => {
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
    await transaction`
      select pg_advisory_xact_lock(
        hashtextextended(${pairing.workspace_id}::text, 0)
      )
    `;
    const replacedDevices = await transaction<DeviceRow[]>`
      update allrice_bridge_devices set revoked_at = now(), updated_at = now()
      where organization_id = ${pairing.organization_id}
        and workspace_id = ${pairing.workspace_id}
        and revoked_at is null
      returning id, organization_id, workspace_id, owner_id, name, platform,
        protocol_version, capabilities, last_seen_at, created_at, revoked_at
    `;
    if (replacedDevices.length) {
      const replacedIds = replacedDevices.map((device) => device.id);
      await transaction`
        update allrice_bridge_folder_grants set revoked_at = now()
        where device_id in ${transaction(replacedIds)} and revoked_at is null
      `;
      await transaction`
        update allrice_bridge_commands
        set status = 'canceled', completed_at = now(), updated_at = now(),
          error_code = 'device_replaced'
        where device_id in ${transaction(replacedIds)}
          and status in ('queued', 'claimed', 'running')
      `;
      await transaction`
        update allrice_bridge_workspace_selection_requests
        set status = 'canceled', completed_at = now(), updated_at = now(),
          error_code = 'device_replaced'
        where device_id in ${transaction(replacedIds)}
          and status in ('queued', 'claimed')
      `;
    }
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
    return { device: row, replacedDevices };
  });
  const { device, replacedDevices } = result;
  for (const replaced of replacedDevices) {
    await audit({
      organizationId: replaced.organization_id,
      workspaceId: replaced.workspace_id,
      actorId: device.owner_id,
      action: 'bridge.device.revoke',
      resourceType: 'bridge_device',
      resourceId: replaced.id,
      reason: 'replaced_by_new_pairing',
      metadata: { replacementDeviceId: device.id },
    });
    await syncBridgeExecutionTarget(replaced, 'revoked');
  }
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
  await syncBridgeExecutionTarget(device, 'online');
  return { device: mapDevice(device), deviceToken: token };
}

export async function listBridgeDevices(
  context: RequestContext,
  workspaceIdInput: string,
  sql = getDatabase(),
  administration?: TenantManagementTarget,
) {
  const workspaceId = UuidSchema.parse(workspaceIdInput);
  if (administration && administration.workspaceId !== workspaceId)
    throw new DataAccessError('authorization_denied');
  const managed = administration
    ? await requireTenantManagementScope(context, administration, sql)
    : null;
  const ownerId =
    managed?.subjectId ?? requireWorkspaceMember(context, workspaceId);
  const organizationId = managed?.organizationId ?? context.organizationId;
  const rows = await sql<DeviceRow[]>`
    select id, organization_id, workspace_id, owner_id, name, platform,
      protocol_version, capabilities, last_seen_at, created_at, revoked_at
    from allrice_bridge_devices
    where organization_id = ${organizationId}
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

export async function heartbeatBridgeDevice(token: string, input?: unknown) {
  const device = await authenticatedDevice(token);
  const advertised = input
    ? HeartbeatBridgeDeviceInputSchema.parse(input)
    : null;
  const sql = getDatabase();
  return sql.begin(async (tx) => {
    const rows = await tx<DeviceRow[]>`
      update allrice_bridge_devices set
        protocol_version = ${advertised?.protocolVersion ?? device.protocol_version},
        capabilities = ${advertised?.capabilities ?? device.capabilities},
        last_seen_at = now(), updated_at = now()
      where id = ${device.id} and revoked_at is null
      returning id, organization_id, workspace_id, owner_id, name, platform,
        protocol_version, capabilities, last_seen_at, created_at, revoked_at
    `;
    const row = rows[0];
    if (!row) throw new BridgeDataError('device_unauthorized');
    const environment = advertised?.environment;
    await syncBridgeExecutionTarget(
      row,
      environment?.paused ? 'offline' : 'online',
      tx,
      environment,
    );
    if (environment && (environment.paused || environment.sandbox !== 'ready'))
      await tx`update allrice_bridge_runtime_profiles set profile=jsonb_set(profile,'{available}','false'::jsonb),reported_at=clock_timestamp()
        where device_id=${device.id}`;
    await preparePairedBrowserGrant(tx, mapDevice(row), environment);
    return mapDevice(row);
  });
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
  await syncBridgeExecutionTarget(device, 'revoked');
}

export async function createBridgeFolderGrant(token: string, input: unknown) {
  const device = await authenticatedDevice(token);
  const parsed = CreateBridgeFolderGrantInputSchema.parse(input);
  const sql = getDatabase();
  const grant = await sql.begin(async (transaction) => {
    await transaction`
      update allrice_bridge_folder_grants set revoked_at = now()
      where device_id = ${device.id} and revoked_at is null
        and root_fingerprint <> ${parsed.rootFingerprint}
    `;
    const rows = await transaction<GrantRow[]>`
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
    return rows[0]!;
  });
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
  const rows = await sql<DeviceRow[]>`
    update allrice_bridge_devices set revoked_at = now(), updated_at = now()
    where id = ${deviceId} and organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId} and owner_id = ${ownerId}
      and revoked_at is null
    returning id, organization_id, workspace_id, owner_id, name, platform,
      protocol_version, capabilities, last_seen_at, created_at, revoked_at
  `;
  const device = rows[0];
  if (!device) throw new DataAccessError('not_found');
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
  await syncBridgeExecutionTarget(device, 'revoked');
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

export async function requestBridgeWorkspaceSelection(
  context: RequestContext,
  workspaceIdInput: string,
  deviceIdInput: string,
) {
  const workspaceId = UuidSchema.parse(workspaceIdInput);
  const deviceId = UuidSchema.parse(deviceIdInput);
  const ownerId = requireWorkspaceMember(context, workspaceId);
  const sql = getDatabase();
  const request = await sql.begin(async (transaction) => {
    const devices = await transaction<{ id: string }[]>`
      select id from allrice_bridge_devices
      where id = ${deviceId}
        and organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId}
        and owner_id = ${ownerId}
        and revoked_at is null
        and last_seen_at > now() - (${onlineWindowSeconds} * interval '1 second')
        and last_seen_at <= now()
      for update
    `;
    if (!devices[0]) throw new BridgeDataError('device_offline');
    await transaction`
      update allrice_bridge_workspace_selection_requests
      set status = 'canceled', completed_at = now(), updated_at = now(),
        error_code = 'superseded'
      where device_id = ${deviceId} and status in ('queued', 'claimed')
    `;
    const rows = await transaction<WorkspaceSelectionRow[]>`
      insert into allrice_bridge_workspace_selection_requests (
        organization_id, workspace_id, owner_id, device_id
      ) values (
        ${context.organizationId}, ${workspaceId}, ${ownerId}, ${deviceId}
      ) returning id, device_id, status, lease_token, requested_at
    `;
    return rows[0]!;
  });
  await sql`select pg_notify('allrice_bridge_workspace_selection', ${deviceId})`;
  await audit({
    organizationId: context.organizationId,
    workspaceId,
    actorId: ownerId,
    action: 'bridge.workspace_selection.request',
    resourceType: 'bridge_workspace_selection',
    resourceId: request.id,
    reason: 'workspace_owner_requested_native_picker',
    requestId: context.requestId,
    metadata: { deviceId },
  });
  return { id: request.id, status: request.status };
}

export async function claimNextBridgeWorkspaceSelection(token: string) {
  const device = await authenticatedDevice(token);
  const leaseToken = randomUUID();
  const sql = getDatabase();
  const request = await sql.begin(async (transaction) => {
    await transaction`
      update allrice_bridge_workspace_selection_requests
      set status = 'failed', completed_at = now(), updated_at = now(),
        error_code = 'selection_timeout'
      where device_id = ${device.id} and status = 'claimed'
        and claimed_at < now() - interval '10 minutes'
    `;
    const rows = await transaction<WorkspaceSelectionRow[]>`
      with candidate as (
        select id from allrice_bridge_workspace_selection_requests
        where device_id = ${device.id} and status = 'queued'
        order by requested_at for update skip locked limit 1
      )
      update allrice_bridge_workspace_selection_requests request
      set status = 'claimed', lease_token = ${leaseToken},
        claimed_at = now(), updated_at = now()
      from candidate where request.id = candidate.id
      returning request.id, request.device_id, request.status,
        request.lease_token, request.requested_at
    `;
    await transaction`
      update allrice_bridge_devices set last_seen_at = now(), updated_at = now()
      where id = ${device.id}
    `;
    return rows[0] ?? null;
  });
  return request ? mapWorkspaceSelection(request) : null;
}

export async function completeBridgeWorkspaceSelection(
  token: string,
  requestIdInput: string,
  input: unknown,
) {
  const device = await authenticatedDevice(token);
  const requestId = UuidSchema.parse(requestIdInput);
  const parsed = CompleteBridgeWorkspaceSelectionInputSchema.parse(input);
  const sql = getDatabase();
  if (parsed.status === 'succeeded') {
    const grants = await sql<{ id: string }[]>`
      select id from allrice_bridge_folder_grants
      where id = ${parsed.grantId!} and device_id = ${device.id}
        and organization_id = ${device.organization_id}
        and workspace_id = ${device.workspace_id}
        and owner_id = ${device.owner_id} and revoked_at is null
    `;
    if (!grants[0]) throw new BridgeDataError('grant_missing');
  }
  const rows = await sql<{ id: string }[]>`
    update allrice_bridge_workspace_selection_requests set
      status = ${parsed.status}, selected_grant_id = ${parsed.grantId ?? null},
      error_code = ${parsed.errorCode ?? null}, completed_at = now(),
      updated_at = now()
    where id = ${requestId} and device_id = ${device.id}
      and lease_token = ${parsed.leaseToken} and status = 'claimed'
    returning id
  `;
  if (!rows[0]) throw new BridgeDataError('lease_lost');
  await audit({
    organizationId: device.organization_id,
    workspaceId: device.workspace_id,
    actorId: device.owner_id,
    action: 'bridge.workspace_selection.complete',
    resourceType: 'bridge_workspace_selection',
    resourceId: requestId,
    decision: parsed.status === 'succeeded' ? 'allowed' : 'denied',
    reason: parsed.errorCode ?? 'native_picker_confirmed_local_root',
    metadata: { deviceId: device.id, grantId: parsed.grantId ?? null },
  });
  return { status: parsed.status };
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
    reason:
      parsed.errorCode ??
      (['local.fs.write', 'local.fs.mkdir'].includes(row.capability)
        ? 'local_managed_write_execution'
        : 'local_read_only_execution'),
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
  const targets = await sql<
    { device_id: string; grant_id: string; grant_label: string }[]
  >`
    select d.id as device_id, g.id as grant_id, g.label as grant_label
    from allrice_bridge_devices d
    join lateral (
      select id, label from allrice_bridge_folder_grants
      where device_id = d.id and revoked_at is null
      order by created_at desc limit 1
    ) g on true
    where d.organization_id = ${input.context.organizationId}
      and d.workspace_id = ${workspaceId} and d.owner_id = ${ownerId}
      and d.revoked_at is null
      and d.last_seen_at > now() - (${onlineWindowSeconds} * interval '1 second')
      and d.last_seen_at <= now()
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
        workspaceLabel: target.grant_label,
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
