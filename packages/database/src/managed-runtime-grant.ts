import { createHash } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { UuidSchema, type BridgeDevice } from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { cloudStableId } from './cloud-execution.ts';

/** The existing opaque device identity authorizes a private VM, never host files. */
export function managedRuntimeFingerprint(deviceId: string) {
  return createHash('sha256')
    .update(`allrice-managed-python-v1:${UuidSchema.parse(deviceId)}`)
    .digest('hex');
}
export async function readManagedRuntimeGrant(
  device: BridgeDevice,
  db = getDatabase(),
) {
  const [row] = await db<
    {
      id: string;
      root_fingerprint: string;
      runtime_generation: number;
      revoked_at: Date | null;
    }[]
  >`
    select id,root_fingerprint,runtime_generation,revoked_at from allrice_bridge_managed_runtime_grants
    where device_id=${device.id} and organization_id=${device.organizationId} and workspace_id=${device.workspaceId} and owner_id=${device.ownerId} and profile_version=1`;
  return row
    ? {
        id: row.id,
        deviceId: device.id,
        rootFingerprint: row.root_fingerprint,
        runtimeGeneration: row.runtime_generation,
        revokedAt: row.revoked_at?.toISOString() ?? null,
        profileVersion: 1 as const,
      }
    : null;
}
/** Caller holds the live device lock and has verified its action-specific physical probe. */
export async function upsertManagedRuntimeGrant(
  tx: TransactionSql,
  device: BridgeDevice,
) {
  await tx`insert into allrice_bridge_managed_runtime_grants(id,device_id,organization_id,workspace_id,owner_id,profile_version,root_fingerprint)
    values(${cloudStableId(`managed-python-grant:${device.id}`)},${device.id},${device.organizationId},${device.workspaceId},${device.ownerId},1,${managedRuntimeFingerprint(device.id)})
    on conflict(device_id) do update set revoked_at=null,
      runtime_generation=allrice_bridge_managed_runtime_grants.runtime_generation+case when allrice_bridge_managed_runtime_grants.revoked_at is null then 0 else 1 end
    where allrice_bridge_managed_runtime_grants.organization_id=excluded.organization_id and allrice_bridge_managed_runtime_grants.workspace_id=excluded.workspace_id
      and allrice_bridge_managed_runtime_grants.owner_id=excluded.owner_id and allrice_bridge_managed_runtime_grants.root_fingerprint=excluded.root_fingerprint`;
}
