import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as client from '../core/client.ts';
import { createRuntimeFixtureDatabase } from '../runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import { authenticateSession, createSession } from '../identity.ts';
import {
  createChatSession,
  getEmployeeWorkspace,
  sendChatMessage,
} from '../workspace/service.ts';
import {
  createBridgePairing,
  pairBridgeDevice,
  heartbeatBridgeDevice,
  revokeCurrentBridgeDevice,
  hasOnlineOwnedBridgeDevice,
} from '../bridge.ts';
import { savePlatformEmployeeDraft } from './platform-employees.ts';
import { createEmployeeInstance } from './employee-instances.ts';
import { resolveEmployeeExecution } from './employeehub.ts';
import { freezeConnectedLocalToolNames } from './local-tool-qualification.ts';

const localTools = [
  'local.fs.list',
  'local.fs.search',
  'local.fs.read',
  'local.fs.write',
  'local.fs.mkdir',
  'local.git.status',
  'local.git.diff',
  'local.process.execute',
  'local.process.status',
  'local.process.stop',
  'local.file.inspect',
  'local.file.derive',
  'local.file.save',
  'local.preview.open',
];
const unchangedTools = [
  'workspace.skill.read',
  'workspace.project',
  'local.browser.workspace',
];
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite('local tools: new Run device qualification', () => {
  let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  beforeAll(async () => {
    f = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    await f?.close();
  });

  async function setup(tools = [...unchangedTools, ...localTools]) {
    const source = await createEmployeeAdministrationFixture(f.db);
    await savePlatformEmployeeDraft(source.employeeId, {
      definition: {
        ...source.definition,
        capabilities: { ...source.definition.capabilities, toolNames: tools },
      },
    });
    await source.preview();
    expect((await source.publish()).valid).toBe(true);
    const context = (await authenticateSession(
      (await createSession(source.ownerId)).token,
      {
        organizationId: source.organizationId,
        workspaceId: source.workspaceId,
      },
    ))!;
    const assignment = (
      await getEmployeeWorkspace(context, source.workspaceId)
    ).employees.find(
      (entry) =>
        entry.currentVersion.manifest.schemaVersion === 2 &&
        entry.currentVersion.manifest.runtimePackage?.skills.some(
          (s) => s.id === source.skillId,
        ),
    )!;
    const custom = await createEmployeeInstance(context, {
      workspaceId: source.workspaceId,
      assignmentId: assignment.id,
      requestId: randomUUID(),
      profile: { name: 'Local task employee' },
    });
    const send = async (kind: 'general' | 'custom' = 'general') => {
      const session = await createChatSession(context, {
        workspaceId: source.workspaceId,
        ...(kind === 'custom'
          ? { employeeInstanceId: custom.id }
          : { employeeAssignmentId: assignment.id }),
        title: 'Local qualification fixture',
      });
      const input = {
        text: '请检查我电脑上已经授权的文件。',
        clientMessageId: randomUUID(),
      };
      const sent = await sendChatMessage(
        context,
        source.workspaceId,
        session.id,
        input,
      );
      return { sent, input, session };
    };
    const scope = {
      organizationId: source.organizationId,
      workspaceId: source.workspaceId,
      ownerId: source.ownerId,
    };
    const resolve = (runId: string) =>
      resolveEmployeeExecution({ ...scope, runId });
    const pair = async () => {
      const pairing = await createBridgePairing(context, {
        workspaceId: source.workspaceId,
        deviceName: 'Synthetic connected computer',
      });
      return pairBridgeDevice({
        code: pairing.code,
        platform: 'macos-arm64',
        protocolVersion: 2,
        capabilities: ['local.fs.list'],
      });
    };
    return { source, context, assignment, scope, send, resolve, pair };
  }

  const environment = {
    version: 1 as const,
    clientVersion: '0.6.0-dev.58',
    browser: 'unavailable' as const,
    sandbox: 'unavailable' as const,
    preview: 'unavailable' as const,
    paused: false,
  };
  const heartbeat = (token: string, paused = false) =>
    heartbeatBridgeDevice(token, {
      protocolVersion: 2,
      capabilities: ['local.fs.list'],
      environment: { ...environment, paused },
    });

  it('persists no local group without a connected owner device; a later connection affects only new Runs', async () => {
    const x = await setup();
    const [publication] =
      await f.db`select manifest,config_checksum from allrice_employee_versions where id=${x.assignment.currentVersion.id}`;
    const first = await x.send();
    const old = (await x.resolve(first.sent.run.id)).executionSnapshot!;
    expect(
      old.capabilitySnapshot.bindings.toolNames.filter((n) =>
        localTools.includes(n),
      ),
    ).toEqual([]);
    expect(old.capabilitySnapshot.bindings.toolNames).toEqual(
      expect.arrayContaining(unchangedTools),
    );
    const device = await x.pair();
    await heartbeat(device.deviceToken);
    expect((await x.resolve(first.sent.run.id)).executionSnapshot).toEqual(old);
    expect(
      (
        await sendChatMessage(
          x.context,
          x.source.workspaceId,
          first.session.id,
          first.input,
        )
      ).run.id,
    ).toBe(first.sent.run.id);
    for (const kind of ['general', 'custom'] as const) {
      const current = await x.send(kind);
      const snapshot = (await x.resolve(current.sent.run.id))
        .executionSnapshot!;
      expect(snapshot.capabilitySnapshot.bindings.toolNames).toEqual(
        expect.arrayContaining(localTools),
      );
      const [stored] =
        await f.db`select execution_snapshot from allrice_employee_runs where id=${current.sent.run.id}`;
      expect(
        stored!.execution_snapshot.capabilitySnapshot.bindings.toolNames,
      ).toEqual(snapshot.capabilitySnapshot.bindings.toolNames);
    }
    const [after] =
      await f.db`select manifest,config_checksum from allrice_employee_versions where id=${x.assignment.currentVersion.id}`;
    expect(after).toEqual(publication);
  });

  it('uses Bridge paused/stale/future/revoked presence and never recomputes an existing Run', async () => {
    const x = await setup();
    const device = await x.pair();
    await heartbeat(device.deviceToken);
    const initial = await x.send();
    const frozen = (await x.resolve(initial.sent.run.id)).executionSnapshot;
    const absent = async () => {
      const next = await x.resolve((await x.send()).sent.run.id);
      expect(
        next.executionSnapshot!.capabilitySnapshot.bindings.toolNames.filter(
          (n) => localTools.includes(n),
        ),
      ).toEqual([]);
      expect((await x.resolve(initial.sent.run.id)).executionSnapshot).toEqual(
        frozen,
      );
    };
    await heartbeat(device.deviceToken, true);
    await absent();
    await heartbeat(device.deviceToken);
    await f.db`update allrice_bridge_devices set last_seen_at=clock_timestamp()-interval '91 seconds' where id=${device.device.id}`;
    await absent();
    await f.db`update allrice_bridge_devices set last_seen_at=clock_timestamp()+interval '1 minute' where id=${device.device.id}`;
    await absent();
    await heartbeat(device.deviceToken);
    await revokeCurrentBridgeDevice(device.deviceToken);
    await absent();
    // Existing per-operation authority still rejects the revoked credential.
    await expect(heartbeat(device.deviceToken)).rejects.toThrow(
      'device_unauthorized',
    );
  });

  it('cannot borrow another owner, workspace or organization device or add an undeclared tool', async () => {
    const x = await setup(['workspace.skill.read', 'local.fs.list']);
    const device = await x.pair();
    await heartbeat(device.deviceToken);
    for (const key of ['ownerId', 'workspaceId', 'organizationId'] as const) {
      const scope = { ...x.scope, [key]: randomUUID() };
      expect(await hasOnlineOwnedBridgeDevice(scope, f.db)).toBe(false);
      expect(
        await freezeConnectedLocalToolNames(
          [...localTools, ...unchangedTools],
          scope,
          f.db,
        ),
      ).toEqual(unchangedTools);
    }
    const current = await x.resolve((await x.send()).sent.run.id);
    expect(
      current.executionSnapshot!.capabilitySnapshot.bindings.toolNames.filter(
        (n) => localTools.includes(n),
      ),
    ).toEqual(['local.fs.list']);
    expect(
      await freezeConnectedLocalToolNames(
        ['local.mcp.call', 'local.file.import', 'local.browser.workspace'],
        x.scope,
        f.db,
      ),
    ).toEqual([
      'local.mcp.call',
      'local.file.import',
      'local.browser.workspace',
    ]);
  });

  it('reads uncommitted presence through the admission transaction, without an outside-pool lookup', async () => {
    const x = await setup();
    const device = await x.pair();
    await heartbeat(device.deviceToken);
    const pool = vi.spyOn(client, 'getDatabase').mockImplementation(() => {
      throw Error('outside_transaction');
    });
    try {
      await f.db
        .begin(async (tx) => {
          await tx`update allrice_bridge_devices set revoked_at=clock_timestamp() where id=${device.device.id}`;
          expect(
            await freezeConnectedLocalToolNames(
              [...localTools, ...unchangedTools],
              x.scope,
              tx,
            ),
          ).toEqual(unchangedTools);
          throw Error('rollback_presence');
        })
        .catch((error: unknown) => {
          expect((error as Error).message).toBe('rollback_presence');
        });
    } finally {
      pool.mockReturnValue(f.db);
    }
    expect(await hasOnlineOwnedBridgeDevice(x.scope, f.db)).toBe(true);
  });
});
