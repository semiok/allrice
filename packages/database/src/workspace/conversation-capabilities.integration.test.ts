import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cloudProjectCapabilityId } from '@allrice/contracts';
import * as client from '../core/client.ts';
import { createRuntimeFixtureDatabase } from '../runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import { authenticateSession, createSession } from '../identity.ts';
import {
  createChatSession,
  getEmployeeWorkspace,
  sendChatMessage,
} from './service.ts';
import { loadPlatformContentCatalog } from '../platform-content/catalog.ts';
import { synchronizePlatformContent } from '../platform-content/sync.ts';
import { savePlatformEmployeeDraft } from '../employees/platform-employees.ts';
import { createEmployeeInstance } from '../employees/employee-instances.ts';
import { resolveEmployeeExecution } from '../employees/employeehub.ts';
import { updateUserPreferences } from '../user-preferences.ts';
import { qualifyConversationProjectTools } from './conversation-capabilities.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'account cloud project configuration frozen at conversation creation',
  () => {
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

    async function setup(rice = true, projectTool = true) {
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
            nativeSkillIds: [
              source.skillId,
              ...(projectTool ? [project.id] : []),
            ],
            toolNames: [
              'workspace.skill.read',
              'workspace.export.create',
              ...(projectTool ? ['workspace.project'] : []),
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
        profile: { name: 'Development fixture employee' },
      });
      const create = (
        kind: 'general' | 'custom' = 'general',
        sessionId?: string,
        ordinary = true,
      ) =>
        createChatSession(
          context,
          {
            workspaceId: source.workspaceId,
            ...(kind === 'custom'
              ? { employeeInstanceId: custom.id }
              : { employeeAssignmentId: assignment.id }),
            title: 'Cloud project configuration fixture',
          },
          {
            sessionId,
            ...(ordinary ? { freezeAccountCapabilities: true as const } : {}),
          },
        );
      const configure = (enabled: boolean) =>
        updateUserPreferences(context, {
          capabilities: {
            [cloudProjectCapabilityId]: { configVersion: 1, enabled },
          },
        });
      const resolve = (runId: string) =>
        resolveEmployeeExecution({
          organizationId: source.organizationId,
          workspaceId: source.workspaceId,
          ownerId: source.ownerId,
          runId,
        });
      const send = async (sessionId: string) => {
        const input = {
          text: '检查本对话的项目开发资格。',
          clientMessageId: randomUUID(),
          deliveryMode: 'follow_up',
        };
        const sent = await sendChatMessage(
          context,
          source.workspaceId,
          sessionId,
          input,
        );
        const resolved = await resolve(sent.run.id);
        return {
          sent,
          input,
          resolved,
          tools:
            resolved.executionSnapshot!.capabilitySnapshot.bindings.toolNames,
        };
      };
      const snapshot = async (sessionId: string) => {
        const [row] =
          await f.db`select account_capability_snapshot from allrice_chat_sessions where id=${sessionId}`;
        return row!.account_capability_snapshot;
      };
      const scope = (sessionId: string) => ({
        organizationId: source.organizationId,
        workspaceId: source.workspaceId,
        ownerId: source.ownerId,
        sessionId,
      });
      return {
        source,
        context,
        assignment,
        project,
        create,
        configure,
        resolve,
        send,
        snapshot,
        scope,
      };
    }

    it('freezes off/on/off at birth across all own employees; later account edits and retries cannot change a conversation', async () => {
      const x = await setup();
      const off = await x.create();
      await x.configure(true);
      const on = await x.create('custom');
      const original = await x.send(on.id);
      expect(original.tools).toContain('workspace.project');
      await x.configure(false);
      const nextOff = await x.create('custom');
      for (const session of [off, nextOff]) {
        const result = await x.send(session.id);
        expect(result.tools).not.toContain('workspace.project');
        expect(result.tools).toContain('workspace.skill.read');
        expect(
          result.tools.filter((name) =>
            name.startsWith('workspace.employee.method.'),
          ),
        ).toEqual([]);
        const skill = result.resolved.nativeSkills.find(
          (s) => s.id === x.project.id,
        )!;
        expect(
          skill.requiredToolRefs.every((tool) => result.tools.includes(tool)),
        ).toBe(false);
      }
      expect((await x.send(on.id)).tools).toContain('workspace.project');
      const before = await x.snapshot(on.id);
      expect(before).toMatchObject({
        ...x.scope(on.id),
        capabilityId: cloudProjectCapabilityId,
        configVersion: 1,
        enabled: true,
      });
      expect((await x.create('custom', on.id)).id).toBe(on.id);
      expect(await x.snapshot(on.id)).toEqual(before);
      const replay = await sendChatMessage(
        x.context,
        x.source.workspaceId,
        on.id,
        original.input,
      );
      expect(replay.run.id).toBe(original.sent.run.id);
      expect((await x.resolve(replay.run.id)).executionSnapshot).toEqual(
        original.resolved.executionSnapshot,
      );
      await expect(
        f.db`update allrice_chat_sessions set account_capability_snapshot=null where id=${on.id}`,
      ).rejects.toThrow('immutable');
      expect(await x.snapshot(on.id)).toEqual(before);
    });

    it('applies the same default and enabled configuration to another published employee without mutating publication', async () => {
      const x = await setup(false);
      const [before] =
        await f.db`select manifest,config_checksum from allrice_employee_versions where id=${x.assignment.currentVersion.id}`;
      expect((await x.send((await x.create()).id)).tools).not.toContain(
        'workspace.project',
      );
      await x.configure(true);
      for (const kind of ['general', 'custom'] as const) {
        const result = await x.send((await x.create(kind)).id);
        expect(result.tools).toContain('workspace.project');
        expect(result.resolved.executionSnapshot!.employee.definition).toEqual(
          before!.manifest,
        );
      }
      const [after] =
        await f.db`select manifest,config_checksum from allrice_employee_versions where id=${x.assignment.currentVersion.id}`;
      expect(after).toEqual(before);
    });

    it('never adds undeclared project tools even when enabled', async () => {
      const x = await setup(false, false);
      await x.configure(true);
      const session = await x.create();
      expect((await x.snapshot(session.id)).enabled).toBe(true);
      expect((await x.send(session.id)).tools).not.toContain(
        'workspace.project',
      );
    });

    it('does not reread account capability settings on later Runs or existing-session retries', async () => {
      const x = await setup();
      await x.configure(true);
      const session = await x.create();
      await f.db`update allrice_user_preferences set capability_settings='{}'::jsonb where user_id=${x.source.ownerId}`;
      expect((await x.send(session.id)).tools).toContain('workspace.project');
      expect((await x.create('general', session.id)).id).toBe(session.id);
      const reserved = randomUUID();
      await expect(x.create('general', reserved)).rejects.toThrow();
      expect(
        await f.db`select id from allrice_chat_sessions where id=${reserved}`,
      ).toHaveLength(0);
      // Server-authorized callers do not opt in, even with malformed account data.
      const server = await x.create('general', undefined, false);
      expect(await x.snapshot(server.id)).toBeNull();
    });

    it('keeps legacy/no-snapshot qualification and cannot backfill old sessions', async () => {
      const x = await setup();
      await x.configure(true);
      const general = await x.create('general', undefined, false);
      const custom = await x.create('custom', undefined, false);
      expect(await x.snapshot(general.id)).toBeNull();
      expect((await x.send(general.id)).tools).not.toContain(
        'workspace.project',
      );
      expect((await x.send(custom.id)).tools).toContain('workspace.project');
      await x.configure(false);
      await x.create('custom', custom.id);
      expect(await x.snapshot(custom.id)).toBeNull();
      expect((await x.send(custom.id)).tools).toContain('workspace.project');
    });

    it('fails closed on foreign scope or malformed/digest-mismatched persisted references', async () => {
      const x = await setup();
      await x.configure(true);
      const session = await x.create();
      const tools = ['workspace.project', 'workspace.skill.read'];
      for (const key of [
        'organizationId',
        'workspaceId',
        'ownerId',
        'sessionId',
      ] as const) {
        await expect(
          qualifyConversationProjectTools(
            f.db,
            { ...x.scope(session.id), [key]: randomUUID() },
            tools,
            true,
          ),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
      }
      const frozen = await x.snapshot(session.id);
      for (const patch of [
        { enabled: false },
        { ownerId: randomUUID() },
        { configVersion: 2 },
        { configurationDigest: 'sha256:invalid' },
      ]) {
        const id = randomUUID();
        await f.db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_instance_id,employee_version_id,title,visibility,account_capability_snapshot)
        select ${id},organization_id,workspace_id,owner_id,employee_assignment_id,employee_instance_id,employee_version_id,title,visibility,
          ${f.db.json({ ...frozen, sessionId: id, ...patch })} from allrice_chat_sessions where id=${session.id}`;
        await expect(
          qualifyConversationProjectTools(f.db, x.scope(id), tools, true),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
      }
      // Tenant assignment revocation remains authoritative, despite frozen on.
      await f.db`update allrice_employee_assignments set active=false where id=${x.assignment.id}`;
      await expect(x.send(session.id)).rejects.toMatchObject({
        // Existing send admission hides inactive assignments as not found.
        code: 'not_found',
      });
      expect(
        await f.db`select run_id from allrice_employee_runs where session_id=${session.id}`,
      ).toHaveLength(0);
    });

    it('concurrent same-ID creation returns a single immutable configuration', async () => {
      const x = await setup();
      await x.configure(true);
      const id = randomUUID();
      const sessions = await Promise.all([
        x.create('general', id),
        x.create('general', id),
      ]);
      expect(sessions.map((s) => s.id)).toEqual([id, id]);
      expect((await x.snapshot(id)).enabled).toBe(true);
      await x.configure(false);
      await x.create('general', id);
      expect((await x.snapshot(id)).enabled).toBe(true);
    });
  },
);
