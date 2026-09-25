import {
  getBridgeSettings,
  updateBridgeSettings,
  bridgeSettingsCommand,
} from './bridge-settings.ts';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import {
  bridgeDeviceStatus,
  heartbeatBridgeDevice,
  listBridgeDevices,
  requestBridgeWorkspaceSelection,
} from './bridge.ts';
import type * as Client from './core/client.ts';

let database: ReturnType<typeof postgres>, admin: ReturnType<typeof postgres>;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => database,
}));
const schema = `bridge_presence_${randomUUID().replaceAll('-', '')}`;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

async function fixture() {
  const org = randomUUID(),
    workspace = randomUUID(),
    owner = randomUUID(),
    device = randomUUID();
  const token = `synthetic-presence-${randomUUID()}`;
  const context: RequestContext = {
    actor: { type: 'user', id: owner },
    organizationId: org,
    workspaceId: workspace,
    requestId: randomUUID(),
    sessionId: randomUUID(),
    authenticatedAt: new Date().toISOString(),
    memberships: [
      {
        id: randomUUID(),
        organizationId: org,
        workspaceId: workspace,
        userId: owner,
        role: 'admin',
        active: true,
      },
    ],
  };
  await database.begin(async (tx) => {
    await tx`insert into allrice_users(id,email,display_name,password_hash) values(${owner},${`${owner}@example.test`},'Synthetic presence','not-login')`;
    await tx`insert into allrice_organizations(id,slug,name) values(${org},${`presence-${org}`},'Synthetic presence')`;
    await tx`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspace},${org},'presence','Synthetic presence')`;
    await tx`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role) values(${context.memberships[0]!.id},${org},${workspace},${owner},'admin')`;
    await tx`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash,last_seen_at)
      values(${device},${org},${workspace},${owner},'Synthetic Bridge','macos-arm64',2,array['local.fs.list'],${createHash('sha256').update(token).digest('hex')},now()-interval '1 second')`;
  });
  return { org, workspace, owner, device, token, context };
}

suite(
  'Bridge presence: real PostgreSQL, isolated tenants, no Bridge process',
  () => {
    beforeAll(async () => {
      const source = process.env.ALLRICE_TEST_DATABASE_URL;
      if (!source) throw Error('dedicated test database required');
      const url = new URL(source);
      const local =
        ['127.0.0.1', 'localhost'].includes(url.hostname) &&
        url.port === '5432' &&
        url.username === 'a123' &&
        ['/allrice_b1', '/allrice_b2'].includes(url.pathname);
      const ci =
        url.hostname === '127.0.0.1' &&
        url.port === '54329' &&
        url.username === 'allrice' &&
        url.pathname === '/allrice';
      if (!local && !ci)
        throw Error('Only explicitly disposable database allowed');
      admin = postgres(source, { max: 2, onnotice: () => {} });
      await admin.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(20260907,1)`;
        await tx`create extension if not exists vector with schema public`;
        await tx`create extension if not exists pg_trgm with schema public`;
      });
      await admin.unsafe(`create schema ${schema}`);
      url.searchParams.set('options', `-csearch_path=${schema},public`);
      database = postgres(url.toString(), { max: 3, onnotice: () => {} });
      const migrations = new URL('../migrations/', import.meta.url);
      for (const file of (await readdir(migrations))
        .filter((name) => name.endsWith('.sql'))
        .sort())
        await database.unsafe(
          await readFile(new URL(file, migrations), 'utf8'),
        );
    }, 60000);
    afterAll(async () => {
      await database?.end();
      if (admin) {
        if (!/^bridge_presence_[a-f0-9]{32}$/.test(schema))
          throw Error('bad schema');
        await admin.unsafe(`drop schema ${schema} cascade`);
        await admin.end();
      }
    });
    it('persists concurrent owner switches, acknowledges actual Bridge settings, and retains local choices', async () => {
      const f = await fixture();
      const settings = {
        localCommand: true,
        localBrowser: true,
        development: true,
      };
      const environment = {
        version: 1 as const,
        clientVersion: '0.6.0-dev.4',
        browser: 'unavailable' as const,
        sandbox: 'unavailable' as const,
        preview: 'unavailable' as const,
        paused: false,
        settings,
        settingsRevision: 0,
      };
      await heartbeatBridgeDevice(f.token, {
        protocolVersion: 2,
        capabilities: ['local.fs.list'],
        environment,
      });
      expect(
        await getBridgeSettings(f.context, f.workspace, f.device),
      ).toMatchObject({ settings, pending: false, supported: true });
      await Promise.all([
        updateBridgeSettings(f.context, f.workspace, f.device, {
          capability: 'localBrowser',
          enabled: false,
        }),
        updateBridgeSettings(f.context, f.workspace, f.device, {
          capability: 'development',
          enabled: false,
        }),
      ]);
      const command = await bridgeSettingsCommand(f.token);
      expect(command).toEqual({
        revision: 2,
        settings: {
          localCommand: true,
          localBrowser: false,
          development: false,
        },
      });
      expect(
        await getBridgeSettings(f.context, f.workspace, f.device),
      ).toMatchObject({ pending: true, settings: command!.settings });
      await heartbeatBridgeDevice(f.token, {
        protocolVersion: 2,
        capabilities: ['local.fs.list'],
        environment: {
          ...environment,
          settings: command!.settings,
          settingsRevision: 2,
        },
      });
      expect(
        await getBridgeSettings(f.context, f.workspace, f.device),
      ).toMatchObject({ pending: false, revision: 2 });
      await heartbeatBridgeDevice(f.token, {
        protocolVersion: 2,
        capabilities: ['local.fs.list'],
        environment: {
          ...environment,
          settings: { ...command!.settings, localBrowser: true },
          settingsRevision: 2,
        },
      });
      expect(
        (await getBridgeSettings(f.context, f.workspace, f.device)).settings
          .localBrowser,
      ).toBe(true);
    });
    it('does not allow another owner, tenant or revoked pairing to change device settings', async () => {
      const own = await fixture(),
        other = await fixture();
      await heartbeatBridgeDevice(own.token);
      for (const context of [
        other.context,
        {
          ...own.context,
          actor: { type: 'user' as const, id: other.owner },
          memberships: [
            { ...own.context.memberships[0]!, userId: other.owner },
          ],
        },
      ]) {
        await expect(
          updateBridgeSettings(context, own.workspace, own.device, {
            capability: 'localCommand',
            enabled: false,
          }),
        ).rejects.toBeDefined();
      }
      expect(await bridgeSettingsCommand(own.token)).toBeNull();
      await database`update allrice_bridge_devices set revoked_at=now() where id=${own.device}`;
      await expect(
        updateBridgeSettings(own.context, own.workspace, own.device, {
          capability: 'localCommand',
          enabled: false,
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
    });
    it('reports online even without a folder grant; list/status reads never manufacture a heartbeat', async () => {
      const f = await fixture();
      const before =
        await database`select last_seen_at,updated_at from allrice_bridge_devices where id=${f.device}`;
      for (let i = 0; i < 3; i++)
        expect(await listBridgeDevices(f.context, f.workspace)).toMatchObject([
          { id: f.device, status: 'online', folderGrants: [] },
        ]);
      expect((await bridgeDeviceStatus(f.token)).device.status).toBe('online');
      expect(
        await database`select last_seen_at,updated_at from allrice_bridge_devices where id=${f.device}`,
      ).toEqual(before);
    });
    it('retains stored folder authorization without reporting an expired heartbeat online', async () => {
      const f = await fixture();
      await database`insert into allrice_bridge_folder_grants(organization_id,workspace_id,owner_id,device_id,label,root_fingerprint)
      values(${f.org},${f.workspace},${f.owner},${f.device},'Synthetic Folder',${'a'.repeat(64)})`;
      expect(await listBridgeDevices(f.context, f.workspace)).toMatchObject([
        { status: 'online', folderGrants: [{ label: 'Synthetic Folder' }] },
      ]);
      await database`update allrice_bridge_devices set last_seen_at=now()-interval '91 seconds' where id=${f.device}`;
      expect(await listBridgeDevices(f.context, f.workspace)).toMatchObject([
        { status: 'offline', folderGrants: [{ label: 'Synthetic Folder' }] },
      ]);
      await expect(
        requestBridgeWorkspaceSelection(f.context, f.workspace, f.device),
      ).rejects.toMatchObject({ code: 'device_offline' });
    });
    it('never treats absent or future heartbeats as live or dispatches a selection request', async () => {
      const f = await fixture();
      for (const lastSeen of [null, new Date(Date.now() + 86400000)]) {
        await database`update allrice_bridge_devices set last_seen_at=${lastSeen} where id=${f.device}`;
        expect(
          (await listBridgeDevices(f.context, f.workspace))[0]?.status,
        ).toBe('offline');
        expect((await bridgeDeviceStatus(f.token)).device.status).toBe(
          'offline',
        );
        await expect(
          requestBridgeWorkspaceSelection(f.context, f.workspace, f.device),
        ).rejects.toMatchObject({ code: 'device_offline' });
      }
    });
    it('keeps the established 90-second display expiry boundary', async () => {
      const f = await fixture();
      const observedAt = Date.now(),
        seenAt = new Date(observedAt - 90000);
      await database`update allrice_bridge_devices set last_seen_at=${seenAt} where id=${f.device}`;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(observedAt);
      try {
        expect(
          (await listBridgeDevices(f.context, f.workspace))[0]?.status,
        ).toBe('online');
        clock.mockReturnValue(observedAt + 1);
        expect(
          (await listBridgeDevices(f.context, f.workspace))[0]?.status,
        ).toBe('offline');
      } finally {
        clock.mockRestore();
      }
    });
    it('only authenticated device traffic renews an expired heartbeat', async () => {
      const f = await fixture();
      await database`update allrice_bridge_devices set last_seen_at=now()-interval '10 minutes' where id=${f.device}`;
      await expect(
        heartbeatBridgeDevice('invalid-synthetic-token'),
      ).rejects.toMatchObject({ code: 'device_unauthorized' });
      expect((await listBridgeDevices(f.context, f.workspace))[0]?.status).toBe(
        'offline',
      );
      await heartbeatBridgeDevice(f.token);
      expect((await listBridgeDevices(f.context, f.workspace))[0]?.status).toBe(
        'online',
      );
    });
    it('does not leak another owner/tenant or a revoked device', async () => {
      const f = await fixture(),
        other = await fixture();
      await expect(
        listBridgeDevices(other.context, f.workspace),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      const otherOwner = randomUUID();
      const wrongOwner: RequestContext = {
        ...f.context,
        actor: { type: 'user', id: otherOwner },
        memberships: f.context.memberships.map((m) => ({
          ...m,
          userId: otherOwner,
        })),
      };
      expect(await listBridgeDevices(wrongOwner, f.workspace)).toEqual([]);
      const wrongTenant: RequestContext = {
        ...f.context,
        organizationId: other.org,
        memberships: f.context.memberships.map((m) => ({
          ...m,
          organizationId: other.org,
        })),
      };
      expect(await listBridgeDevices(wrongTenant, f.workspace)).toEqual([]);
      await database`update allrice_bridge_devices set revoked_at=now() where id=${f.device}`;
      expect(await listBridgeDevices(f.context, f.workspace)).toEqual([]);
      await expect(bridgeDeviceStatus(f.token)).rejects.toMatchObject({
        code: 'device_unauthorized',
      });
    });
  },
);
