import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import {
  bridgeDeviceStatus,
  createBridgePairing,
  createBridgeFolderGrant,
  listBridgeDevices,
  pairBridgeDevice,
  requestBridgeWorkspaceSelection,
  revokeBridgeDevice,
} from './bridge.ts';
import { updateBridgeSettings } from './bridge-settings.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

integration('organization/employee Bridge ownership', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    fixture = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    await fixture?.close();
  });

  async function person(org: string, workspace: string) {
    const user = randomUUID(),
      membership = randomUUID();
    await fixture.db`insert into allrice_users(id,email,display_name,password_hash)
      values(${user},${`${user}@example.test`},'Synthetic employee','not-login')`;
    await fixture.db`insert into allrice_memberships(id,organization_id,user_id,role)
      values(${membership},${org},${user},'member')`;
    const context: RequestContext = {
      actor: { type: 'user', id: user },
      organizationId: org,
      workspaceId: workspace,
      sessionId: randomUUID(),
      requestId: randomUUID(),
      authenticatedAt: new Date().toISOString(),
      memberships: [
        {
          id: membership,
          organizationId: org,
          workspaceId: null,
          userId: user,
          role: 'member',
          active: true,
        },
      ],
    };
    return { user, membership, context };
  }
  async function company() {
    const org = randomUUID(),
      workspace = randomUUID();
    await fixture.db`insert into allrice_organizations(id,slug,name,managed_employee_roster)
      values(${org},${`bridge-owner-${org}`},'Synthetic company',true)`;
    await fixture.db`insert into allrice_workspaces(id,organization_id,slug,name)
      values(${workspace},${org},'default','默认工作区')`;
    await fixture.db`update allrice_organizations set default_workspace_id=${workspace} where id=${org}`;
    return {
      org,
      workspace,
      a: await person(org, workspace),
      b: await person(org, workspace),
    };
  }
  async function code(context: RequestContext) {
    return createBridgePairing(context, {
      workspaceId: context.workspaceId,
      deviceName: 'Synthetic computer',
    });
  }
  const consume = (pairing: { code: string }) =>
    pairBridgeDevice({
      code: pairing.code,
      name: 'Synthetic Bridge',
      platform: 'macos-arm64',
      protocolVersion: 2,
      capabilities: ['local.fs.list', 'local.fs.read'],
    });
  const connect = async (context: RequestContext) =>
    consume(await code(context));

  it('cleans the old workspace policy and personal label while retaining company data and completed receipts', async () => {
    const f = await company(),
      extra = randomUUID(),
      old = randomUUID(),
      newer = randomUUID();
    const project = randomUUID(),
      grant = randomUUID();
    // Reconstruct the old permitted state: one employee had a device in each
    // internal workspace. Another employee's device must survive migration.
    await fixture.db`drop index allrice_bridge_devices_one_active_per_employee`;
    await fixture.db`create unique index allrice_bridge_devices_one_active_per_workspace
      on allrice_bridge_devices(organization_id,workspace_id) where revoked_at is null`;
    await fixture.db`insert into allrice_workspaces(id,organization_id,slug,name)
      values(${extra},${f.org},'legacy-other','Legacy execution scope')`;
    await fixture.db`update allrice_workspaces set name='Snow Workspace' where id=${f.workspace}`;
    await fixture.db`insert into allrice_projects(id,organization_id,workspace_id,owner_id,name)
      values(${project},${f.org},${f.workspace},${f.a.user},'Company document project')`;
    for (const [id, workspace, age] of [
      [old, f.workspace, 60],
      [newer, extra, 1],
    ] as const) {
      await fixture.db`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash,last_seen_at)
        values(${id},${f.org},${workspace},${f.a.user},'Legacy computer','macos-arm64',2,array['local.fs.list'],${createHash('sha256').update(id).digest('hex')},now()-${age}*interval '1 second')`;
    }
    await fixture.db`insert into allrice_bridge_folder_grants(id,organization_id,workspace_id,owner_id,device_id,label,root_fingerprint)
      values(${grant},${f.org},${f.workspace},${f.a.user},${old},'Synthetic folder',${'a'.repeat(64)})`;
    const command = randomUUID();
    await fixture.db`insert into allrice_bridge_commands(id,organization_id,workspace_id,owner_id,device_id,folder_grant_id,capability,arguments,status,idempotency_key,timeout_at,completed_at,result,summary)
      values(${command},${f.org},${f.workspace},${f.a.user},${old},${grant},'local.fs.list','{}','succeeded',${command},now()+interval '1 minute',now(),'{"entries":[]}','original receipt')`;
    const migration = await readFile(
      new URL(
        '../migrations/0179_bridge_employee_device_scope.sql',
        import.meta.url,
      ),
      'utf8',
    );
    await fixture.db.begin((tx) => tx.unsafe(migration));
    expect(
      (
        await fixture.db`select value from allrice_runtime_metadata where key='rice-bridge-active-device-policy'`
      )[0]!.value.scope,
    ).toBe('organization-employee');
    expect(
      (
        await fixture.db`select name from allrice_workspaces where id=${f.workspace}`
      )[0]!.name,
    ).toBe('默认工作区');
    expect(
      await fixture.db`select id from allrice_projects where id=${project}`,
    ).toHaveLength(1);
    const devices =
      await fixture.db`select id,revoked_at from allrice_bridge_devices where organization_id=${f.org}`;
    expect(devices.find((d) => d.id === old)!.revoked_at).toBeTruthy();
    expect(devices.find((d) => d.id === newer)!.revoked_at).toBeNull();
    expect(
      (
        await fixture.db`select revoked_at from allrice_bridge_folder_grants where id=${grant}`
      )[0]!.revoked_at,
    ).toBeTruthy();
    expect(
      (
        await fixture.db`select status,result,summary from allrice_bridge_commands where id=${command}`
      )[0],
    ).toEqual({
      status: 'succeeded',
      result: { entries: [] },
      summary: 'original receipt',
    });
    // A different employee can immediately pair into the same organization.
    const b = await connect(f.b.context);
    expect((await bridgeDeviceStatus(b.deviceToken)).device.ownerId).toBe(
      f.b.user,
    );
    expect(
      (
        await fixture.db`select revoked_at from allrice_bridge_devices where id=${newer}`
      )[0]!.revoked_at,
    ).toBeNull();
  });

  it('pairs two employees in the same company without displacing either, and keeps folder grants private', async () => {
    const f = await company(),
      a = await connect(f.a.context),
      b = await connect(f.b.context);
    await createBridgeFolderGrant(a.deviceToken, {
      label: 'A private folder',
      rootFingerprint: 'a'.repeat(64),
    });
    await createBridgeFolderGrant(b.deviceToken, {
      label: 'B private folder',
      rootFingerprint: 'b'.repeat(64),
    });
    const av = await listBridgeDevices(f.a.context, f.workspace),
      bv = await listBridgeDevices(f.b.context, f.workspace);
    expect(av.map((d) => d.id)).toEqual([a.device.id]);
    expect(bv.map((d) => d.id)).toEqual([b.device.id]);
    expect(av[0]!.folderGrants.map((g) => g.label)).toEqual([
      'A private folder',
    ]);
    expect(bv[0]!.folderGrants.map((g) => g.label)).toEqual([
      'B private folder',
    ]);
    expect((await bridgeDeviceStatus(a.deviceToken)).device.status).toBe(
      'online',
    );
    expect((await bridgeDeviceStatus(b.deviceToken)).device.status).toBe(
      'online',
    );
  });

  it('replaces only the same employee across internal workspaces in one organization', async () => {
    const f = await company(),
      a = await connect(f.a.context),
      b = await connect(f.b.context);
    const second = randomUUID();
    await fixture.db`insert into allrice_workspaces(id,organization_id,slug,name) values(${second},${f.org},'other','Internal scope')`;
    const next = await connect({ ...f.a.context, workspaceId: second });
    expect(next.device.ownerId).toBe(f.a.user);
    await expect(bridgeDeviceStatus(a.deviceToken)).rejects.toMatchObject({
      code: 'device_unauthorized',
    });
    expect((await bridgeDeviceStatus(b.deviceToken)).device.status).toBe(
      'online',
    );
    expect((await bridgeDeviceStatus(next.deviceToken)).device.status).toBe(
      'online',
    );
  });

  it('serializes concurrent pairings of one employee while another employee stays connected', async () => {
    const f = await company(),
      b = await connect(f.b.context);
    const [one, two] = await Promise.all([
      code(f.a.context),
      code(f.a.context),
    ]);
    const results = await Promise.all([consume(one), consume(two)]);
    const active = await listBridgeDevices(f.a.context, f.workspace);
    expect(active).toHaveLength(1);
    expect(results.map((r) => r.device.id)).toContain(active[0]!.id);
    expect((await bridgeDeviceStatus(b.deviceToken)).device.status).toBe(
      'online',
    );
    await expect(consume(one)).rejects.toMatchObject({
      code: 'pairing_invalid',
    });
    expect(await listBridgeDevices(f.b.context, f.workspace)).toHaveLength(1);
  });

  it('keeps the same employee devices independent across two organizations', async () => {
    const f = await company(),
      other = await company();
    const a = await connect(f.a.context),
      membership = randomUUID();
    await fixture.db`insert into allrice_memberships(id,organization_id,user_id,role)
      values(${membership},${other.org},${f.a.user},'member')`;
    const context: RequestContext = {
      ...f.a.context,
      organizationId: other.org,
      workspaceId: other.workspace,
      memberships: [
        ...f.a.context.memberships,
        {
          id: membership,
          organizationId: other.org,
          workspaceId: null,
          userId: f.a.user,
          role: 'member',
          active: true,
        },
      ],
    };
    const second = await connect(context);
    expect((await bridgeDeviceStatus(a.deviceToken)).device.status).toBe(
      'online',
    );
    expect(
      (await listBridgeDevices(context, other.workspace)).map((d) => d.id),
    ).toEqual([second.device.id]);
    await connect(f.a.context);
    expect((await bridgeDeviceStatus(second.deviceToken)).device.status).toBe(
      'online',
    );
  });

  it('rejects another employee changing permissions, revoking a device or requesting a folder picker', async () => {
    const f = await company(),
      a = await connect(f.a.context),
      b = await connect(f.b.context);
    await expect(
      updateBridgeSettings(f.b.context, f.workspace, a.device.id, {
        capability: 'localCommand',
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      revokeBridgeDevice(f.b.context, f.workspace, a.device.id),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      requestBridgeWorkspaceSelection(f.b.context, f.workspace, a.device.id),
    ).rejects.toMatchObject({ code: 'device_offline' });
    expect((await bridgeDeviceStatus(a.deviceToken)).device.status).toBe(
      'online',
    );
    expect((await bridgeDeviceStatus(b.deviceToken)).device.status).toBe(
      'online',
    );
  });

  it.each([
    'account-disabled',
    'membership-removed',
    'company-archived',
    'scope-archived',
  ])(
    'rejects an unused pairing code after %s without replacing another device',
    async (reason) => {
      const f = await company(),
        b = await connect(f.b.context),
        pending = await code(f.a.context);
      if (reason === 'account-disabled')
        await fixture.db`update allrice_users set status='disabled' where id=${f.a.user}`;
      if (reason === 'membership-removed')
        await fixture.db`update allrice_memberships set active=false where id=${f.a.membership}`;
      if (reason === 'company-archived')
        await fixture.db`update allrice_organizations set archived_at=now() where id=${f.org}`;
      if (reason === 'scope-archived')
        await fixture.db`update allrice_workspaces set archived_at=now() where id=${f.workspace}`;
      await expect(consume(pending)).rejects.toMatchObject({
        code: 'pairing_invalid',
      });
      expect(
        (
          await fixture.db`select revoked_at from allrice_bridge_devices where id=${b.device.id}`
        )[0]!.revoked_at,
      ).toBeNull();
    },
  );
});
