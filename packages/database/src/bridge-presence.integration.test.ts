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
  BridgeDataError,
  heartbeatBridgeDevice,
  listBridgeDevices,
  requestBridgeWorkspaceSelection,
  completeBridgeCommand,
  completeBridgeWorkspaceSelection,
} from './bridge.ts';
import type * as Client from './core/client.ts';
import {
  resolveWorkbenchTerminalTarget,
  revalidateBridgeTerminalTarget,
} from './workbench-terminal.ts';

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

async function fixture(tenant?: { org: string; workspace: string }) {
  const org = tenant?.org ?? randomUUID(),
    workspace = tenant?.workspace ?? randomUUID(),
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
    if (!tenant) {
      await tx`insert into allrice_organizations(id,slug,name) values(${org},${`presence-${org}`},'Synthetic presence')`;
      await tx`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspace},${org},'presence','Synthetic presence')`;
    }
    await tx`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role) values(${context.memberships[0]!.id},${org},${workspace},${owner},'admin')`;
    await tx`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash,last_seen_at)
      values(${device},${org},${workspace},${owner},'Synthetic Bridge','macos-arm64',2,array['local.fs.list'],${createHash('sha256').update(token).digest('hex')},now()-interval '1 second')`;
  });
  return { org, workspace, owner, device, token, context };
}

async function terminalFixture(tenant?: { org: string; workspace: string }) {
  const f = await fixture(tenant),
    session = randomUUID(),
    grant = randomUUID(),
    employee = randomUUID(),
    version = randomUUID(),
    assignment = randomUUID();
  await database.begin(async (tx) => {
    await tx`insert into allrice_sessions(id,user_id,token_hash,expires_at)
      values(${f.context.sessionId!},${f.owner},${createHash('sha256').update(randomUUID()).digest('hex')},now()+interval '1 day')`;
    await tx`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name)
      values(${employee},${f.org},${f.workspace},${`human-terminal-${employee}`},'Synthetic human terminal')`;
    await tx`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest)
      values(${version},${f.org},${f.workspace},${employee},1,'Synthetic terminal fixture','synthetic','No model execution','[]',${'sha256:' + 'a'.repeat(64)},'{}')`;
    await tx`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id)
      values(${assignment},${f.org},${f.workspace},${employee},${version},${f.owner})`;
    await tx`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id)
      values(${session},${f.org},${f.workspace},${f.owner},'Synthetic human terminal',${assignment},${version})`;
    await tx`insert into allrice_bridge_folder_grants(id,organization_id,workspace_id,owner_id,device_id,label,root_fingerprint)
      values(${grant},${f.org},${f.workspace},${f.owner},${f.device},'Authorized initial directory',${'a'.repeat(64)})`;
  });
  const environment = {
    version: 1 as const,
    clientVersion: '0.6.0-dev.58',
    browser: 'unavailable' as const,
    sandbox: 'unavailable' as const,
    preview: 'unavailable' as const,
    paused: false,
    humanTerminalVersion: 1 as const,
  };
  const heartbeat = (changes: Partial<typeof environment> = {}) =>
    heartbeatBridgeDevice(f.token, {
      protocolVersion: 2,
      capabilities: ['local.fs.list'],
      environment: { ...environment, ...changes },
    });
  await heartbeat();
  const input = {
    workspaceId: f.workspace,
    sessionId: session,
    deviceId: f.device,
    grantId: grant,
  };
  return { ...f, session, grant, input, environment, heartbeat };
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

    it('human terminal authority binds the actual login, private chat and grant generation without mutating presence', async () => {
      const f = await terminalFixture();
      const before =
        await database`select d.last_seen_at,d.updated_at,g.runtime_generation,t.metadata
        from allrice_bridge_devices d join allrice_bridge_folder_grants g on g.device_id=d.id
        join allrice_execution_targets t on t.target_key='bridge.'||d.id::text
        where d.id=${f.device} and g.id=${f.grant}`;
      expect(await listBridgeDevices(f.context, f.workspace)).toMatchObject([
        { id: f.device, humanTerminalVersion: 1 },
      ]);
      const expected = {
        deviceName: 'Synthetic Bridge',
        target: {
          organizationId: f.org,
          workspaceId: f.workspace,
          ownerId: f.owner,
          loginSessionId: f.context.sessionId,
          sessionId: f.session,
          deviceId: f.device,
          grantId: f.grant,
          grantVersion: 1,
          rootFingerprint: 'a'.repeat(64),
          label: 'Authorized initial directory',
        },
      };
      await expect(
        resolveWorkbenchTerminalTarget(f.context, f.input),
      ).resolves.toEqual(expected);
      await expect(
        revalidateBridgeTerminalTarget(f.token, expected.target),
      ).resolves.toEqual(expected);
      expect(
        await database`select d.last_seen_at,d.updated_at,g.runtime_generation,t.metadata
        from allrice_bridge_devices d join allrice_bridge_folder_grants g on g.device_id=d.id
        join allrice_execution_targets t on t.target_key='bridge.'||d.id::text
        where d.id=${f.device} and g.id=${f.grant}`,
      ).toEqual(before);
      expect(
        await database`select id from allrice_bridge_commands where device_id=${f.device}`,
      ).toHaveLength(0);
      expect(
        await database`select id from allrice_runs where owner_id=${f.owner}`,
      ).toHaveLength(0);
    });
    it('human terminal authority rejects foreign owners, tenants, workspaces, chats, devices, grants and login sessions', async () => {
      const own = await terminalFixture(),
        other = await terminalFixture(),
        coworker = await terminalFixture(own);
      const { target } = await resolveWorkbenchTerminalTarget(
        own.context,
        own.input,
      );
      for (const [context, input, code] of [
        [other.context, own.input, 'authorization_denied'],
        [coworker.context, own.input, 'not_found'],
        [
          own.context,
          { ...own.input, deviceId: coworker.device, grantId: coworker.grant },
          'not_found',
        ],
        [
          coworker.context,
          { ...coworker.input, deviceId: own.device, grantId: own.grant },
          'not_found',
        ],
        [
          { ...own.context, actor: { type: 'user' as const, id: other.owner } },
          own.input,
          'not_found',
        ],
        [{ ...own.context, organizationId: other.org }, own.input, 'not_found'],
        [
          own.context,
          { ...own.input, workspaceId: other.workspace },
          'authorization_denied',
        ],
        [own.context, { ...own.input, sessionId: other.session }, 'not_found'],
        [own.context, { ...own.input, deviceId: other.device }, 'not_found'],
        [own.context, { ...own.input, grantId: other.grant }, 'not_found'],
        [
          { ...own.context, sessionId: other.context.sessionId },
          own.input,
          'not_found',
        ],
        [{ ...own.context, sessionId: randomUUID() }, own.input, 'not_found'],
        [
          {
            ...own.context,
            actor: { type: 'service' as const, id: randomUUID() },
          },
          own.input,
          'authorization_denied',
        ],
      ] as const) {
        await expect(
          resolveWorkbenchTerminalTarget(context, input),
        ).rejects.toMatchObject({ code });
      }
      await expect(
        revalidateBridgeTerminalTarget(other.token, target),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        revalidateBridgeTerminalTarget(coworker.token, target),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        revalidateBridgeTerminalTarget(own.token, {
          ...target,
          ownerId: other.owner,
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
    });
    it('human terminal authority uses the current database role even when cached context still says admin', async () => {
      const f = await terminalFixture();
      const { target } = await resolveWorkbenchTerminalTarget(
        f.context,
        f.input,
      );
      expect(f.context.memberships[0]!.role).toBe('admin');
      await database`update allrice_memberships set role='viewer' where id=${f.context.memberships[0]!.id}`;
      await expect(
        resolveWorkbenchTerminalTarget(f.context, f.input),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        revalidateBridgeTerminalTarget(f.token, target),
      ).rejects.toMatchObject({ code: 'not_found' });
      await database`update allrice_memberships set role='member' where id=${f.context.memberships[0]!.id}`;
      await expect(
        revalidateBridgeTerminalTarget(f.token, target),
      ).resolves.toMatchObject({ target });
    });
    it.each([
      'archived chat',
      'revoked grant',
      'revoked pairing',
      'logged out',
      'expired login',
      'disabled user',
      'inactive membership',
      'archived organization',
      'archived workspace',
      'paused device',
    ] as const)(
      'human terminal authority revokes a previously valid target after %s',
      async (change) => {
        const f = await terminalFixture();
        const { target } = await resolveWorkbenchTerminalTarget(
          f.context,
          f.input,
        );
        if (change === 'archived chat')
          await database`update allrice_chat_sessions set archived_at=now() where id=${f.session}`;
        else if (change === 'revoked grant')
          await database`update allrice_bridge_folder_grants set revoked_at=now() where id=${f.grant}`;
        else if (change === 'revoked pairing')
          await database`update allrice_bridge_devices set revoked_at=now() where id=${f.device}`;
        else if (change === 'logged out')
          await database`update allrice_sessions set revoked_at=now() where id=${f.context.sessionId!}`;
        else if (change === 'expired login')
          await database`update allrice_sessions set created_at=now()-interval '2 days',expires_at=now()-interval '1 day' where id=${f.context.sessionId!}`;
        else if (change === 'disabled user')
          await database`update allrice_users set status='disabled' where id=${f.owner}`;
        else if (change === 'inactive membership')
          await database`update allrice_memberships set active=false where id=${f.context.memberships[0]!.id}`;
        else if (change === 'archived organization')
          await database`update allrice_organizations set archived_at=now() where id=${f.org}`;
        else if (change === 'archived workspace')
          await database`update allrice_workspaces set archived_at=now() where id=${f.workspace}`;
        else if (change === 'paused device')
          await f.heartbeat({ paused: true });
        await expect(
          resolveWorkbenchTerminalTarget(f.context, f.input),
        ).rejects.toMatchObject({ code: 'not_found' });
        await expect(
          revalidateBridgeTerminalTarget(f.token, target),
        ).rejects.toMatchObject({
          code:
            change === 'revoked pairing' ? 'device_unauthorized' : 'not_found',
        });
      },
    );
    it.each(['expired', 'missing', 'future'] as const)(
      'human terminal authority retains an authorized target with %s heartbeat while declining a new browser admission',
      async (heartbeat) => {
        const f = await terminalFixture();
        const { target } = await resolveWorkbenchTerminalTarget(
          f.context,
          f.input,
        );
        const lastSeen =
          heartbeat === 'missing'
            ? null
            : new Date(Date.now() + (heartbeat === 'future' ? 60000 : -91000));
        await database`update allrice_bridge_devices set last_seen_at=${lastSeen} where id=${f.device}`;
        const before =
          await database`select last_seen_at,updated_at from allrice_bridge_devices where id=${f.device}`;
        await expect(
          resolveWorkbenchTerminalTarget(f.context, f.input),
        ).rejects.toBeInstanceOf(BridgeDataError);
        await expect(
          resolveWorkbenchTerminalTarget(f.context, f.input),
        ).rejects.toMatchObject({ code: 'device_offline' });
        await expect(
          revalidateBridgeTerminalTarget(f.token, target),
        ).resolves.toMatchObject({ target });
        expect(
          await database`select last_seen_at,updated_at from allrice_bridge_devices where id=${f.device}`,
        ).toEqual(before);
        await database`update allrice_sessions set revoked_at=now() where id=${f.context.sessionId!}`;
        await expect(
          revalidateBridgeTerminalTarget(f.token, target),
        ).rejects.toMatchObject({ code: 'not_found' });
      },
    );
    it.each([
      'legacy capability report',
      'missing environment',
      'missing execution target',
    ] as const)(
      'human terminal authority treats %s as unavailable evidence rather than process revocation',
      async (report) => {
        const f = await terminalFixture();
        const { target } = await resolveWorkbenchTerminalTarget(
          f.context,
          f.input,
        );
        if (report === 'legacy capability report') {
          const { humanTerminalVersion, ...legacyEnvironment } = f.environment;
          expect(humanTerminalVersion).toBe(1);
          await heartbeatBridgeDevice(f.token, {
            protocolVersion: 2,
            capabilities: ['local.fs.list'],
            environment: legacyEnvironment,
          });
        } else if (report === 'missing environment') {
          await database`update allrice_execution_targets set metadata=metadata-'environment' where target_key=${`bridge.${f.device}`}`;
        } else {
          await database`delete from allrice_execution_targets where target_key=${`bridge.${f.device}`}`;
        }
        expect(
          (await listBridgeDevices(f.context, f.workspace))[0]
            ?.humanTerminalVersion,
        ).toBeUndefined();
        await expect(
          resolveWorkbenchTerminalTarget(f.context, f.input),
        ).rejects.toBeInstanceOf(BridgeDataError);
        await expect(
          resolveWorkbenchTerminalTarget(f.context, f.input),
        ).rejects.toMatchObject({ code: 'device_offline' });
        await expect(
          revalidateBridgeTerminalTarget(f.token, target),
        ).rejects.toBeInstanceOf(BridgeDataError);
        await expect(
          revalidateBridgeTerminalTarget(f.token, target),
        ).rejects.toMatchObject({ code: 'device_offline' });
        await database`update allrice_bridge_folder_grants set revoked_at=now() where id=${f.grant}`;
        await expect(
          revalidateBridgeTerminalTarget(f.token, target),
        ).rejects.toMatchObject({ code: 'not_found' });
      },
    );
    it('human terminal authority accepts a display-only folder label change without accepting a changed security pin', async () => {
      const f = await terminalFixture();
      const { target } = await resolveWorkbenchTerminalTarget(
        f.context,
        f.input,
      );
      await database`update allrice_bridge_folder_grants set label='Renamed authorized initial directory' where id=${f.grant}`;
      const [grant] =
        await database`select runtime_generation from allrice_bridge_folder_grants where id=${f.grant}`;
      expect(grant!.runtime_generation).toBe(target.grantVersion);
      const current = await resolveWorkbenchTerminalTarget(f.context, f.input);
      expect(current.target).toEqual({
        ...target,
        label: 'Renamed authorized initial directory',
      });
      await expect(
        revalidateBridgeTerminalTarget(f.token, target),
      ).resolves.toEqual(current);
      await expect(
        revalidateBridgeTerminalTarget(f.token, {
          ...target,
          grantVersion: target.grantVersion + 1,
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        revalidateBridgeTerminalTarget(f.token, {
          ...target,
          rootFingerprint: 'b'.repeat(64),
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
    });
    it('human terminal authority rejects a stale grant generation after revoke and reauthorize with the same identity', async () => {
      const f = await terminalFixture();
      const { target } = await resolveWorkbenchTerminalTarget(
        f.context,
        f.input,
      );
      await database`update allrice_bridge_folder_grants set revoked_at=now() where id=${f.grant}`;
      await database`update allrice_bridge_folder_grants set revoked_at=null where id=${f.grant}`;
      const current = await resolveWorkbenchTerminalTarget(f.context, f.input);
      expect(current.target).toEqual({
        ...target,
        grantVersion: target.grantVersion + 2,
      });
      await expect(
        revalidateBridgeTerminalTarget(f.token, target),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        revalidateBridgeTerminalTarget(f.token, current.target),
      ).resolves.toEqual(current);
    });
    it.each(['canceled', 'failed'])(
      'acknowledges a late picker receipt after %s without reviving the request',
      async (status) => {
        const f = await fixture(),
          request = randomUUID(),
          leaseToken = randomUUID();
        await database`insert into allrice_bridge_workspace_selection_requests(id,organization_id,workspace_id,owner_id,device_id,status,lease_token,claimed_at,error_code) values(${request},${f.org},${f.workspace},${f.owner},${f.device},${status},${leaseToken},now()-interval '11 minutes',${status === 'failed' ? 'selection_timeout' : 'superseded'})`;
        const receipt = {
          leaseToken,
          status: 'succeeded',
          grantId: randomUUID(),
        };
        await expect(
          completeBridgeWorkspaceSelection(f.token, request, receipt),
        ).resolves.toEqual({ status, receiptAcknowledged: true });
        const [before] =
          await database`select status,error_code,late_receipt,late_receipt_at from allrice_bridge_workspace_selection_requests where id=${request}`;
        await completeBridgeWorkspaceSelection(f.token, request, receipt);
        await expect(
          completeBridgeWorkspaceSelection(f.token, request, {
            ...receipt,
            leaseToken: randomUUID(),
          }),
        ).rejects.toMatchObject({ code: 'lease_lost' });
        await expect(
          completeBridgeWorkspaceSelection(f.token, request, {
            ...receipt,
            grantId: randomUUID(),
          }),
        ).rejects.toMatchObject({ code: 'lease_lost' });
        const [after] =
          await database`select status,error_code,late_receipt,late_receipt_at from allrice_bridge_workspace_selection_requests where id=${request}`;
        expect(after).toEqual(before);
        expect(after!.status).toBe(status);
        expect(after!.late_receipt.grantId).toBe(receipt.grantId);
      },
    );
    it.each(['expired', 'canceled', 'unknown'])(
      'retains late %s receipts without changing history or accepting another lease',
      async (status) => {
        const f = await fixture();
        const grant = randomUUID(),
          command = randomUUID(),
          lease = randomUUID();
        await database`insert into allrice_bridge_folder_grants(id,organization_id,workspace_id,owner_id,device_id,label,root_fingerprint) values(${grant},${f.org},${f.workspace},${f.owner},${f.device},'Synthetic folder',${'a'.repeat(64)})`;
        await database`insert into allrice_bridge_commands(id,organization_id,workspace_id,owner_id,device_id,folder_grant_id,capability,arguments,status,idempotency_key,lease_token,timeout_at,summary,error_code) values(${command},${f.org},${f.workspace},${f.owner},${f.device},${grant},'local.fs.list','{}',${status},${command},${lease},now()-interval '1 minute','original result','original_code')`;
        const receipt = {
          leaseToken: lease,
          status: 'succeeded',
          output: { entries: [] },
          summary: 'actual receipt',
        };
        await expect(
          completeBridgeCommand(f.token, command, {
            ...receipt,
            leaseToken: randomUUID(),
          }),
        ).rejects.toMatchObject({ code: 'lease_lost' });
        await completeBridgeCommand(f.token, command, receipt);
        const [first] =
          await database`select status,summary,error_code,late_receipt,late_receipt_at from allrice_bridge_commands where id=${command}`;
        expect(first).toMatchObject({
          status,
          summary: 'original result',
          error_code: 'original_code',
          late_receipt: {
            status: 'succeeded',
            output: { entries: [] },
            summary: 'actual receipt',
            errorCode: null,
          },
        });
        expect(first!.late_receipt_at).toBeTruthy();
        await completeBridgeCommand(f.token, command, receipt);
        await expect(
          completeBridgeCommand(f.token, command, {
            ...receipt,
            output: { entries: ['changed'] },
          }),
        ).rejects.toMatchObject({ code: 'lease_lost' });
        const [after] =
          await database`select status,summary,error_code,late_receipt,late_receipt_at from allrice_bridge_commands where id=${command}`;
        expect(after).toEqual(first);
      },
    );
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
    it('lists the version actually reported by each owned device without borrowing another tenant report', async () => {
      const own = await fixture(),
        other = await fixture();
      expect(
        (await listBridgeDevices(own.context, own.workspace))[0]?.clientVersion,
      ).toBeNull();
      await heartbeatBridgeDevice(own.token, {
        protocolVersion: 2,
        capabilities: ['local.fs.list'],
        environment: {
          version: 1,
          clientVersion: '0.6.0-dev.6',
          browser: 'ready',
          sandbox: 'ready',
          preview: 'ready',
          paused: false,
        },
      });
      await heartbeatBridgeDevice(other.token, {
        protocolVersion: 2,
        capabilities: ['local.fs.list'],
        environment: {
          version: 1,
          clientVersion: '0.6.0-dev.7',
          browser: 'ready',
          sandbox: 'ready',
          preview: 'ready',
          paused: false,
        },
      });
      expect(await listBridgeDevices(own.context, own.workspace)).toMatchObject(
        [{ id: own.device, clientVersion: '0.6.0-dev.6' }],
      );
      expect(
        await listBridgeDevices(other.context, other.workspace),
      ).toMatchObject([{ id: other.device, clientVersion: '0.6.0-dev.7' }]);
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
    it('reports a shutdown heartbeat offline immediately, retains authorization and reconnects after resuming', async () => {
      const f = await fixture();
      await database`insert into allrice_bridge_folder_grants(organization_id,workspace_id,owner_id,device_id,label,root_fingerprint)
        values(${f.org},${f.workspace},${f.owner},${f.device},'Retained Folder',${'b'.repeat(64)})`;
      const environment = {
        version: 1 as const,
        clientVersion: '0.6.0-dev.27',
        browser: 'ready' as const,
        sandbox: 'ready' as const,
        preview: 'ready' as const,
        paused: false,
      };
      const heartbeat = (paused: boolean) =>
        heartbeatBridgeDevice(f.token, {
          protocolVersion: 2,
          capabilities: ['local.fs.list'],
          environment: { ...environment, paused },
        });
      expect((await heartbeat(false)).status).toBe('online');
      expect((await listBridgeDevices(f.context, f.workspace))[0]?.status).toBe(
        'online',
      );

      const stopped = await heartbeat(true);
      expect(stopped.status).toBe('offline');
      expect(Date.now() - Date.parse(stopped.lastSeenAt!)).toBeLessThan(90000);
      const before =
        await database`select last_seen_at,updated_at from allrice_bridge_devices where id=${f.device}`;
      for (let i = 0; i < 3; i++) {
        const [device] = await listBridgeDevices(f.context, f.workspace);
        expect(device).toMatchObject({
          status: 'offline',
          folderGrants: [{ label: 'Retained Folder' }],
        });
        expect(
          device!.readiness.every((item) => item.state === 'offline'),
        ).toBe(true);
      }
      expect((await bridgeDeviceStatus(f.token)).device.status).toBe('offline');
      expect(
        await database`select last_seen_at,updated_at from allrice_bridge_devices where id=${f.device}`,
      ).toEqual(before);
      await expect(
        requestBridgeWorkspaceSelection(f.context, f.workspace, f.device),
      ).rejects.toMatchObject({ code: 'device_offline' });

      expect((await heartbeat(false)).status).toBe('online');
      expect(await listBridgeDevices(f.context, f.workspace)).toMatchObject([
        { status: 'online', folderGrants: [{ label: 'Retained Folder' }] },
      ]);
      expect((await bridgeDeviceStatus(f.token)).device.status).toBe('online');
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
