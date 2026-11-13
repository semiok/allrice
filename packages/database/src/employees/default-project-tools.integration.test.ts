import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as toolSelection from '@allrice/contracts';
import * as client from '../core/client.ts';
import { createRuntimeFixtureDatabase } from '../runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import { authenticateSession, createSession } from '../identity.ts';
import {
  createChatSession,
  getEmployeeWorkspace,
  sendChatMessage,
} from '../workspace/service.ts';
import { loadPlatformContentCatalog } from '../platform-content/catalog.ts';
import { synchronizePlatformContent } from '../platform-content/sync.ts';
import { savePlatformEmployeeDraft } from './platform-employees.ts';
import { createEmployeeInstance } from './employee-instances.ts';
import { resolveEmployeeExecution } from './employeehub.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite('default Rice project tool admission', () => {
  let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  let catalog: Awaited<ReturnType<typeof loadPlatformContentCatalog>>;
  beforeAll(async () => {
    f = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
    catalog = await loadPlatformContentCatalog();
    await synchronizePlatformContent(catalog);
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    await f?.close();
  });

  async function setup(rice: boolean) {
    const source = await createEmployeeAdministrationFixture(f.db);
    const project = catalog.skills.find(
      (s) => s.name === 'project-development',
    )!;
    const [platform] = rice
      ? await f.db`select id from allrice_platform_employees where employee_key='rice'`
      : [{ id: source.employeeId }];
    const employeeId = platform!.id as string;
    await savePlatformEmployeeDraft(employeeId, {
      definition: {
        ...source.definition,
        key: rice ? 'rice' : source.definition.key,
        capabilities: {
          ...source.definition.capabilities,
          nativeSkillIds: [source.skillId, project.id],
          toolNames: [
            'workspace.skill.read',
            'workspace.project',
            'workspace.export.create',
          ],
        },
      },
    });
    await source.preview(employeeId);
    expect((await source.publish(employeeId)).valid).toBe(true);
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
      profile: { name: 'My development employee' },
    });
    const send = async (kind: 'general' | 'custom') => {
      const session = await createChatSession(context, {
        workspaceId: source.workspaceId,
        ...(kind === 'custom'
          ? { employeeInstanceId: custom.id }
          : { employeeAssignmentId: assignment.id }),
        title: 'Project admission fixture',
      });
      const input = {
        text: '帮我开发一个用于检查表格的小工具。',
        clientMessageId: randomUUID(),
      };
      const sent = await sendChatMessage(
        context,
        source.workspaceId,
        session.id,
        input,
      );
      return { session, input, sent };
    };
    const resolve = (runId: string) =>
      resolveEmployeeExecution({
        organizationId: source.organizationId,
        workspaceId: source.workspaceId,
        ownerId: source.ownerId,
        runId,
      });
    return { source, context, assignment, send, resolve, project };
  }

  it('reduces only new Rice Runs, preserving custom development and immutable publication', async () => {
    const x = await setup(true);
    const [before] =
      await f.db`select manifest,config_checksum from allrice_employee_versions where id=${x.assignment.currentVersion.id}`;
    for (const kind of ['general', 'custom'] as const) {
      const { sent } = await x.send(kind);
      const resolved = await x.resolve(sent.run.id);
      const snapshot = resolved.executionSnapshot!;
      expect(snapshot.schemaVersion).toBe(2);
      if (snapshot.schemaVersion !== 2) throw Error('snapshot_version');
      const names = snapshot.capabilitySnapshot.bindings.toolNames;
      expect(names.includes('workspace.project')).toBe(kind === 'custom');
      // Workflow installation/authoring does not depend on workspace.project.
      expect(names).toContain('workspace.skill.read');
      expect(
        names.filter((name) => name.startsWith('workspace.employee.method.')),
      ).toEqual([]);
      expect(
        resolved.nativeSkills.find((s) => s.name === 'employee-customization')
          ?.requiredToolRefs,
      ).toEqual([]);
      expect(snapshot.employee.definition).toEqual(before!.manifest);
      // Keep reviewed bytes frozen; the existing adapter omits Skills whose
      // requiredToolRefs are not in the frozen authorized tools.
      const project = resolved.nativeSkills.find((s) => s.id === x.project.id)!;
      expect(project.requiredToolRefs).toContain('workspace.project');
      expect(
        project.requiredToolRefs.every((tool) => names.includes(tool)),
      ).toBe(kind === 'custom');
      const [persisted] =
        await f.db`select execution_snapshot from allrice_employee_runs where run_id=${sent.run.id}`;
      expect(
        persisted!.execution_snapshot.capabilitySnapshot.bindings.toolNames,
      ).toEqual(names);
    }
    const [after] =
      await f.db`select manifest,config_checksum from allrice_employee_versions where id=${x.assignment.currentVersion.id}`;
    expect(after).toEqual(before);
  });

  it('does not remove project development from another published general employee', async () => {
    const x = await setup(false);
    const resolved = await x.resolve((await x.send('general')).sent.run.id);
    expect(
      resolved.executionSnapshot?.capabilitySnapshot.bindings.toolNames,
    ).toContain('workspace.project');
  });

  it('replays and resolves an old Rice Run with its original project qualification', async () => {
    const x = await setup(true);
    // Simulate the old tool selection at first INSERT, never rewrite a stored
    // snapshot or disable its immutability trigger. All admission checks stay real.
    const selectMemoryTools = toolSelection.freezeMemoryIndexToolNames;
    const oldSelection = vi
      .spyOn(toolSelection, 'freezeMemoryIndexToolNames')
      .mockImplementation((...args) => [
        ...selectMemoryTools(...args),
        'workspace.project',
      ]);
    const original = await x
      .send('general')
      .finally(() => oldSelection.mockRestore());
    const before = (await x.resolve(original.sent.run.id)).executionSnapshot;
    expect(before?.capabilitySnapshot.bindings.toolNames).toContain(
      'workspace.project',
    );
    const replay = await sendChatMessage(
      x.context,
      x.source.workspaceId,
      original.session.id,
      original.input,
    );
    expect(replay.run.id).toBe(original.sent.run.id);
    expect((await x.resolve(replay.run.id)).executionSnapshot).toEqual(before);
    const next = await x.resolve((await x.send('general')).sent.run.id);
    expect(
      next.executionSnapshot?.capabilitySnapshot.bindings.toolNames,
    ).not.toContain('workspace.project');
  });
});
