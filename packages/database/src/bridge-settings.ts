import {
  BridgeEnvironmentSchema,
  BridgeSettingsCommandSchema,
  UpdateBridgeSettingsSchema,
  UuidSchema,
  type BridgeSettings,
  type BridgeReadinessCapability,
  type BridgeReadinessState,
  type BridgeCapabilityReadiness,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { bridgeDeviceStatus, listBridgeDevices } from './bridge.ts';

/** Pending owner choices win immediately; after acknowledgement, local choices
 * reported by Bridge win too. Old per-device pauses survive until changed. */
export function bridgeSettingsView(metadata: Record<string, unknown> = {}) {
  const observed = BridgeEnvironmentSchema.safeParse(metadata.environment);
  const command = BridgeSettingsCommandSchema.safeParse(
    metadata.bridgeSettings,
  );
  const environment = observed.success ? observed.data : null;
  const revision = command.success ? command.data.revision : 0;
  const pending = revision > (environment?.settingsRevision ?? 0);
  const settings: BridgeSettings =
    pending && command.success
      ? command.data.settings
      : (environment?.settings ?? {
          localCommand: environment?.sandbox !== 'paused',
          localBrowser: environment?.browser !== 'paused',
          development: true,
        });
  return {
    settings,
    revision,
    pending,
    supported: !!environment?.settings,
    environment,
  };
}

/** Compatibility projection over the last report and revisioned owner choices.
 * It is discovery, not authority. Legacy clients keep their existing paths. */
export function bridgeCapabilityReadinessView(
  metadata: Record<string, unknown>,
  capability: BridgeReadinessCapability,
  online = true,
): Pick<
  BridgeCapabilityReadiness,
  'state' | 'reason' | 'missing' | 'versions'
> {
  const { environment, settings, pending } = bridgeSettingsView(metadata);
  const reported = environment?.readiness?.find(
    (item) => item.capability === capability,
  );
  let state: BridgeReadinessState = reported?.state ?? 'unsupported';
  let reason = reported?.reason ?? 'readiness_not_reported';
  const kind =
    capability === 'local.browser'
      ? 'browser'
      : capability === 'local.preview'
        ? 'preview'
        : capability === 'local.development'
          ? 'development'
          : capability === 'local.process' || capability === 'local.mcp'
            ? 'sandbox'
            : null;
  if (!reported && capability !== 'local.office') {
    const old = kind ? environment?.[kind] : 'ready';
    state =
      old === 'ready'
        ? 'ready'
        : old === 'preparing'
          ? 'preparing'
          : old === 'paused'
            ? 'paused'
            : 'unsupported';
    reason = `legacy_${old ?? 'unreported'}`;
  }
  const enabled =
    kind === 'browser'
      ? settings.localBrowser
      : kind === 'development'
        ? settings.development && settings.localCommand
        : kind === 'sandbox' || kind === 'preview'
          ? settings.localCommand
          : true;
  if (capability === 'local.office') {
    state = 'unsupported';
    reason = 'office_not_implemented';
  } else if (!online) {
    state = 'offline';
    reason = 'bridge_offline';
  } else if (environment?.paused || !enabled) {
    state = 'paused';
    reason = 'capability_paused';
  } else if (kind && pending) {
    state = 'preparing';
    reason = 'settings_pending';
  }
  return {
    state,
    reason,
    missing: reported?.missing ?? [],
    versions:
      reported?.versions ??
      (environment?.clientVersion ? { bridge: environment.clientVersion } : {}),
  };
}

async function ownedDevice(
  context: RequestContext,
  workspaceId: string,
  deviceId: string,
) {
  UuidSchema.parse(deviceId);
  const device = (await listBridgeDevices(context, workspaceId)).find(
    (d) => d.id === deviceId,
  );
  if (!device) throw new DataAccessError('not_found');
  return device;
}

export async function getBridgeSettings(
  context: RequestContext,
  workspaceId: string,
  deviceId: string,
) {
  const device = await ownedDevice(context, workspaceId, deviceId);
  const sql = getDatabase();
  const [target] = await sql<{ metadata: Record<string, unknown> }[]>`
    select metadata from allrice_execution_targets where organization_id=${device.organizationId}
      and workspace_id=${device.workspaceId} and target_key=${`bridge.${device.id}`} and kind='rice_bridge'`;
  return { device, ...bridgeSettingsView(target?.metadata) };
}

export async function updateBridgeSettings(
  context: RequestContext,
  workspaceId: string,
  deviceId: string,
  input: unknown,
) {
  const device = await ownedDevice(context, workspaceId, deviceId);
  const change = UpdateBridgeSettingsSchema.parse(input);
  const sql = getDatabase();
  await sql.begin(async (tx) => {
    const [target] = await tx<
      { id: string; metadata: Record<string, unknown> }[]
    >`
      select id,metadata from allrice_execution_targets where organization_id=${device.organizationId}
        and workspace_id=${device.workspaceId} and target_key=${`bridge.${device.id}`} and kind='rice_bridge' for update`;
    const [current] =
      await tx`select id from allrice_bridge_devices where id=${device.id}
      and organization_id=${device.organizationId} and workspace_id=${device.workspaceId}
      and owner_id=${device.ownerId} and revoked_at is null for share`;
    if (!target || !current) throw new DataAccessError('not_found');
    const view = bridgeSettingsView(target.metadata);
    const settings = { ...view.settings, [change.capability]: change.enabled };
    const command = { revision: view.revision + 1, settings };
    await tx`update allrice_execution_targets set metadata=jsonb_set(metadata,'{bridgeSettings}',${tx.json(command)}),updated_at=now() where id=${target.id}`;
    await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
      values(${device.organizationId},${device.workspaceId},${device.ownerId},'bridge.settings.update','bridge_device',${device.id},'recorded','device_owner',${tx.json({ ...change, revision: command.revision })})`;
  });
  return getBridgeSettings(context, workspaceId, deviceId);
}

export async function bridgeSettingsCommand(token: string) {
  const { device } = await bridgeDeviceStatus(token);
  const sql = getDatabase();
  const [target] = await sql<{ metadata: Record<string, unknown> }[]>`
    select metadata from allrice_execution_targets where organization_id=${device.organizationId}
      and workspace_id=${device.workspaceId} and target_key=${`bridge.${device.id}`} and kind='rice_bridge'`;
  const parsed = BridgeSettingsCommandSchema.safeParse(
    target?.metadata.bridgeSettings,
  );
  return parsed.success ? parsed.data : null;
}
