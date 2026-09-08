import { createHash, randomUUID } from 'node:crypto';

import { UuidSchema } from '@allrice/contracts';

import { getDatabase } from './core/client.ts';

export interface BridgeSocketConnection {
  deviceId: string;
  organizationId: string;
  workspaceId: string;
  connectionId: string;
  serverId: string;
  epoch: string;
}

export class BridgeConnectionError extends Error {
  constructor(readonly code: 'device_unauthorized' | 'connection_replaced') {
    super(code);
  }
}

/** PostgreSQL authority for a transport connection; never authorizes tool execution. */
export function createBridgeConnectionAuthority(
  database = getDatabase(),
  options: { serverId?: string; leaseMs?: number } = {},
) {
  const serverId = UuidSchema.parse(options.serverId ?? randomUUID());
  const leaseMs = options.leaseMs ?? 30_000;
  if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 60_000)
    throw new Error('INVALID_CONNECTION_LEASE');
  return {
    async register(token: string): Promise<BridgeSocketConnection> {
      if (!token || token.length > 256)
        throw new BridgeConnectionError('device_unauthorized');
      return database.begin(async (tx) => {
        await tx`set local statement_timeout='3000ms'`;
        await tx`set local lock_timeout='2000ms'`;
        // Authenticate and lock the device BEFORE registering/replacing its connection.
        // Revocation takes this same row lock, so a revoked device cannot race a new lease.
        const [device] = await tx<
          { id: string; organization_id: string; workspace_id: string }[]
        >`select id,organization_id,workspace_id from allrice_bridge_devices
          where token_hash=${createHash('sha256').update(token).digest('hex')} and revoked_at is null for update`;
        if (!device) throw new BridgeConnectionError('device_unauthorized');
        const connectionId = randomUUID();
        const [row] = await tx<{ epoch: string }[]>`
          insert into allrice_bridge_connections(device_id,organization_id,workspace_id,connection_id,server_id,epoch,expires_at)
          values(${device.id},${device.organization_id},${device.workspace_id},${connectionId},${serverId},1,
            clock_timestamp()+${leaseMs}*interval '1 millisecond')
          on conflict(device_id) do update set connection_id=excluded.connection_id,server_id=excluded.server_id,
            epoch=allrice_bridge_connections.epoch+1,expires_at=excluded.expires_at,updated_at=clock_timestamp()
          returning epoch::text`;
        return {
          deviceId: device.id,
          organizationId: device.organization_id,
          workspaceId: device.workspace_id,
          connectionId,
          serverId,
          epoch: row!.epoch,
        };
      });
    },
    async current(connection: BridgeSocketConnection, renew = false) {
      const rows = renew
        ? await database<{ device_id: string }[]>`
            update allrice_bridge_connections c set expires_at=clock_timestamp()+${leaseMs}*interval '1 millisecond',updated_at=clock_timestamp()
            from allrice_bridge_devices d where c.device_id=${connection.deviceId}
              and c.organization_id=${connection.organizationId} and c.workspace_id=${connection.workspaceId}
              and c.connection_id=${connection.connectionId} and c.server_id=${serverId} and c.epoch=${connection.epoch}
              and c.expires_at>clock_timestamp() and d.id=c.device_id and d.revoked_at is null returning c.device_id`
        : await database<{ device_id: string }[]>`
            select c.device_id from allrice_bridge_connections c join allrice_bridge_devices d on d.id=c.device_id
              where c.device_id=${connection.deviceId} and c.organization_id=${connection.organizationId} and c.workspace_id=${connection.workspaceId}
              and c.connection_id=${connection.connectionId} and c.server_id=${serverId} and c.epoch=${connection.epoch}
              and c.expires_at>clock_timestamp() and d.revoked_at is null`;
      return rows.length === 1;
    },
    async release(connection: BridgeSocketConnection) {
      // A late close from a replaced connection must never expire the newer connection.
      await database`update allrice_bridge_connections set expires_at=clock_timestamp(),updated_at=clock_timestamp()
        where device_id=${connection.deviceId} and connection_id=${connection.connectionId}
          and server_id=${serverId} and epoch=${connection.epoch}`;
    },
    async subscribe(
      listener: (deviceId: string, kind: 'connection' | 'work') => void,
    ) {
      const subscriptions: { unlisten: () => Promise<void> }[] = [];
      try {
        for (const channel of [
          'allrice_bridge_connection',
          'allrice_bridge_runtime_operation',
          'allrice_bridge_commands',
          'allrice_bridge_workspace_selection',
        ]) {
          subscriptions.push(
            await database.listen(channel, (payload) => {
              const id = UuidSchema.safeParse(payload);
              if (id.success)
                listener(
                  id.data,
                  channel === 'allrice_bridge_connection'
                    ? 'connection'
                    : 'work',
                );
            }),
          );
        }
      } catch (error) {
        await Promise.all(subscriptions.map((s) => s.unlisten()));
        throw error;
      }
      return () => Promise.all(subscriptions.map((s) => s.unlisten()));
    },
  };
}
