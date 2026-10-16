import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import * as client from '../core/client.ts';
import * as queue from '../execution/queue.ts';
import {
  createAssistantFixtureDatabase,
  assistantFixtureStorage,
} from '../assistant-runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from '../identity.ts';
import {
  createChatSession,
  getEmployeeWorkspace,
  sendChatMessage,
  linkFileToSession,
} from '../workspace/service.ts';
import { createStorageMetadata, markStorageReady } from '../data.ts';
import { savePlatformEmployeeDraft } from './platform-employees.ts';
import { createEmployeeInstance } from './employee-instances.ts';
import { skillBytesChecksum } from '../skill-bundles.ts';
import { loadPlatformContentCatalog } from '../platform-content/catalog.ts';
import { synchronizePlatformContent } from '../platform-content/sync.ts';
import { assertFrozenBaseSkillCatalog } from './employee-base-skills.ts';
import { resolveEmployeeExecution } from './employeehub.ts';
import {
  prepareEmployeeContentContext,
  assertEmployeeContentContext,
  assertEmployeeContentReferenceMessages,
} from './employee-runtime-content.ts';
import {
  preparePersonalSkillImport,
  installPersonalSkillFromChat,
  listPersonalSkills,
  managePersonalSkill,
  assertFrozenPersonalSkills,
  assertPersonalSkillsReadable,
} from './personal-skills.ts';
import { parsePersonalSkill } from '../../../../apps/worker/src/personal-skill-import.js';
import { installPersonalSkill } from '../../../../apps/worker/src/tool-broker/handlers/personal-skills.js';
import { readSkillResource } from '../../../../apps/worker/src/tool-broker/handlers/skill.js';
import { resolveCloudToolArguments } from '../../../../apps/worker/src/tool-broker/handlers/cloud-frozen-script.js';
import { createFileArchive } from '../../../file-archives/src/index.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'personal Skill attachment → Broker → native parser → binding → frozen context',
  () => {
    let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      f = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      await synchronizePlatformContent(await loadPlatformContentCatalog());
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await f?.close();
    });
    async function setup(cloud = false) {
      const source = await createEmployeeAdministrationFixture(f.db);
      await savePlatformEmployeeDraft(source.employeeId, {
        definition: {
          ...source.definition,
          capabilities: {
            ...source.definition.capabilities,
            toolNames: [
              'workspace.skill.read',
              'workspace.export.create',
              ...(cloud ? ['cloud.process.execute'] : []),
            ],
          },
        },
        expectedRevisionId: source.revisionId,
      });
      await source.preview();
      expect((await source.publish()).valid).toBe(true);
      await f.db`update allrice_memberships set role='member' where user_id=${source.ownerId}`;
      const context = (await authenticateSession(
        (await createSession(source.ownerId)).token,
        {
          organizationId: source.organizationId,
          workspaceId: source.workspaceId,
        },
      ))!;
      const assignment = (
        await getEmployeeWorkspace(context, source.workspaceId)
      ).employees[0]!;
      const custom = await createEmployeeInstance(context, {
        workspaceId: source.workspaceId,
        assignmentId: assignment.id,
        requestId: randomUUID(),
        profile: { name: 'Private skill tester' },
      });
      const run = async (
        instanceId: string,
        text: string,
        raw?: string | { bytes: Uint8Array; fileName: string },
        existingSession?: string,
      ) => {
        const session = existingSession
          ? { id: existingSession }
          : await createChatSession(context, {
              workspaceId: source.workspaceId,
              employeeInstanceId: instanceId,
              title: 'Synthetic personal skill',
            });
        let objectId: string | undefined;
        if (raw !== undefined) {
          const bytes =
            typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(raw.bytes);
          objectId = randomUUID();
          const pending = await createStorageMetadata(context, {
            id: objectId,
            workspaceId: source.workspaceId,
            category: 'uploads',
            mediaType:
              typeof raw === 'string' ? 'text/markdown' : 'application/zip',
            sizeBytes: bytes.byteLength,
            checksum: skillBytesChecksum(bytes),
            visibility: 'private',
            retentionUntil: null,
            immutable: false,
          });
          await assistantFixtureStorage(f.db).put(
            pending.object,
            new Blob([bytes]).stream(),
          );
          await markStorageReady(context, objectId);
          await linkFileToSession({
            context,
            workspaceId: source.workspaceId,
            sessionId: session.id,
            objectId,
            fileName: typeof raw === 'string' ? 'SKILL.md' : raw.fileName,
          });
        }
        const sent = await sendChatMessage(
          context,
          source.workspaceId,
          session.id,
          {
            text,
            clientMessageId: randomUUID(),
            attachmentIds: objectId ? [objectId] : [],
          },
        );
        const workerId = randomUUID(),
          leaseToken = randomUUID();
        const [job] =
          await f.db`update allrice_jobs set status='claimed',worker_id=${workerId},lease_token=${leaseToken},claimed_at=clock_timestamp(),heartbeat_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '5 minutes'
        where run_id=${sent.run.id} returning id`;
        const execution = await queue.startClaimedJob(
          workerId,
          job!.id,
          leaseToken,
        );
        if (!execution) throw Error('personal_skill_fixture_start');
        const [row] =
          await f.db`select user_message_id from allrice_employee_runs where run_id=${sent.run.id}`;
        const scope = {
          organizationId: source.organizationId,
          workspaceId: source.workspaceId,
          ownerId: source.ownerId,
          sessionId: session.id,
          runId: sent.run.id,
        };
        const runtime = await prepareEmployeeContentContext(scope);
        const input = {
          context: execution.context,
          sessionId: session.id,
          userMessageId: row!.user_message_id as string,
          callId: randomUUID(),
          worker: { attempt: execution.job.attempt, leaseToken },
          arguments: { objectId: objectId ?? randomUUID() },
        };
        const finish = async () => {
          await f.db`update allrice_jobs set status='succeeded',completed_at=now() where run_id=${sent.run.id}`;
          await f.db`update allrice_runs set state='succeeded',completed_at=now() where id=${sent.run.id}`;
          await f.db`update allrice_employee_runs set status='succeeded',completed_at=now() where run_id=${sent.run.id}`;
        };
        return { input, scope, runtime: runtime!, finish, execution };
      };
      return { source, context, assignment, custom, run };
    }
    const raw = (name = 'private-checklist') =>
      `---\nname: ${name}\ndescription: Private three item checklist\nmetadata:\n  test: true\n---\nUse three items: source, calculation, delivery.\n`;
    async function broker(
      task: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['run']>>,
      args: Record<string, unknown> = task.input.arguments,
    ) {
      const result = await installPersonalSkill({
        arguments: args,
        input: {
          context: task.input.context,
          sessionId: task.input.sessionId,
          userMessageId: task.input.userMessageId,
          storageRoot: f.storageRoot,
          capabilities: ['storage:read', 'storage:write'],
          call: {
            id: randomUUID(),
            name: 'workspace.personal_skill.install',
            arguments: args,
          },
          managedBrowserJobAttempt: task.input.worker.attempt,
          managedBrowserJobLeaseToken: task.input.worker.leaseToken,
        },
      });
      return JSON.parse(result.modelContent);
    }
    const zip = async (multiple = false) => ({
      fileName: 'weekly.zip',
      bytes: await createFileArchive([
        {
          path: 'weekly/SKILL.md',
          bytes: Buffer.from(
            raw('weekly') +
              'Read references/checklist.md and assets/report.md.\n',
          ),
        },
        {
          path: 'weekly/references/checklist.md',
          bytes: Buffer.from('Confirm source, count, delivery. 私有参考。'),
        },
        {
          path: 'weekly/assets/report.md',
          bytes: Buffer.from('# Report\n## Data\n## Findings\n'),
        },
        ...(multiple
          ? [{ path: 'monthly/SKILL.md', bytes: Buffer.from(raw('monthly')) }]
          : []),
      ]),
    });
    it('installs a ZIP through the real handler, retains private exact resources independently of the source, and revokes reads', async () => {
      const x = await setup();
      const task = await x.run(
        x.custom.id,
        '请把我上传的“weekly.zip”安装到当前 AI 员工。以后使用这个技能。',
        await zip(),
      );
      const first = await broker(task);
      expect(first.status).toBe('installed');
      expect(first.skill.resourceCount).toBe(2);
      expect((await broker(task)).skill.versionId).toBe(first.skill.versionId);
      const [stored] =
        await f.db`select o.* from allrice_personal_skill_imports i join allrice_storage_objects o on o.id=i.archive_object_id where i.instance_id=${x.custom.id}`;
      expect(stored).toMatchObject({
        visibility: 'private',
        immutable: true,
        state: 'ready',
        category: 'memory',
      });
      await f.db`update allrice_storage_objects set state='deleted',deleted_at=now() where id=${task.input.arguments.objectId}`;
      await task.finish();
      const next = await x.run(x.custom.id, '请用 weekly 的参考和模板写报告。');
      const resolved = await resolveEmployeeExecution(next.scope);
      const args = { skill: 'weekly', path: 'references/checklist.md' };
      const request = {
        context: next.input.context,
        sessionId: next.scope.sessionId,
        storageRoot: f.storageRoot,
        nativeSkills: resolved.nativeSkills,
        capabilities: ['storage:read' as const],
        call: {
          id: randomUUID(),
          name: 'workspace.skill.read',
          arguments: args,
        },
      };
      const resource = JSON.parse(
        (await readSkillResource({ input: request, arguments: args }))
          .modelContent,
      );
      expect(resource).toMatchObject({
        text: 'Confirm source, count, delivery. 私有参考。',
        source: 'personal',
        versionId: first.skill.versionId,
        executionPermission: false,
      });
      expect(JSON.stringify(resolved.nativeSkills)).not.toContain(
        'Confirm source, count, delivery. 私有参考。',
      );
      const other = await x.run(x.assignment.id, 'Unbound');
      await expect(
        readSkillResource({
          input: {
            ...request,
            context: other.input.context,
            sessionId: other.scope.sessionId,
          },
          arguments: args,
        }),
      ).rejects.toThrow();
      await other.finish();
      await managePersonalSkill(x.context, {
        workspaceId: x.source.workspaceId,
        instanceId: x.custom.id,
        installationId: first.skill.id,
        expectedRevision: first.skill.revision,
        requestId: randomUUID(),
        operation: 'disable',
      });
      await expect(
        readSkillResource({ input: request, arguments: args }),
      ).rejects.toThrow();
      await next.finish();
    });
    it('persists multi-package choices without installing, then requires one fresh explicit selection in the same session', async () => {
      const x = await setup();
      const first = await x.run(
        x.custom.id,
        '请安装我上传的技能包。',
        await zip(true),
      );
      const pending = await broker(first);
      expect(pending.status).toBe('selection_required');
      expect(
        pending.candidates.map((c: { name: string }) => c.name).sort(),
      ).toEqual(['monthly', 'weekly']);
      expect(await listPersonalSkills(x.context)).toEqual([]);
      expect((await broker(first)).importId).toBe(pending.importId);
      const args = {
        importId: pending.importId,
        candidatePath: 'weekly/SKILL.md',
      };
      await expect(broker(first, args)).rejects.toThrow();
      await first.finish();
      const wrongSession = await x.run(x.custom.id, '请选择“weekly”并安装。');
      await expect(broker(wrongSession, args)).rejects.toThrow();
      await wrongSession.finish();
      const quoted = await x.run(
        x.custom.id,
        '请翻译：“安装 weekly”。',
        undefined,
        first.scope.sessionId,
      );
      await expect(broker(quoted, args)).rejects.toThrow();
      await quoted.finish();
      const chosen = await x.run(
        x.custom.id,
        '请选择“weekly”并安装。',
        undefined,
        first.scope.sessionId,
      );
      const installed = await broker(chosen, args);
      expect(installed.status).toBe('installed');
      expect(installed.skill.name).toBe('weekly');
      expect((await broker(chosen, args)).skill.id).toBe(installed.skill.id);
      expect(
        (await listPersonalSkills(x.context)).map((skill) => skill.name),
      ).toEqual(['weekly']);
      await chosen.finish();
      const replay = await x.run(
        x.custom.id,
        '安装 monthly。',
        undefined,
        first.scope.sessionId,
      );
      await expect(
        broker(replay, { ...args, candidatePath: 'monthly/SKILL.md' }),
      ).rejects.toThrow();
      await replay.finish();
    });
    async function install(
      x: Awaited<ReturnType<typeof setup>>,
      instanceId: string,
    ) {
      const task = await x.run(
        instanceId,
        '请把我上传的“SKILL.md”安装到当前 AI 员工。以后使用这个技能。',
        raw(),
      );
      const result = await installPersonalSkill({
        arguments: task.input.arguments,
        input: {
          context: task.input.context,
          sessionId: task.input.sessionId,
          userMessageId: task.input.userMessageId,
          storageRoot: f.storageRoot,
          capabilities: ['storage:read', 'storage:write'],
          call: {
            id: task.input.callId,
            name: 'workspace.personal_skill.install',
            arguments: task.input.arguments,
          },
          managedBrowserJobAttempt: task.input.worker.attempt,
          managedBrowserJobLeaseToken: task.input.worker.leaseToken,
        },
      });
      const item = JSON.parse(result.modelContent).skill;
      expect(await preparePersonalSkillImport(task.input)).toEqual({
        prior: item,
      });
      await task.finish();
      return { task, item };
    }
    it.each(['cancel', 'expire'] as const)(
      'does not install or revive %s pending imports',
      async (operation) => {
        const x = await setup();
        const first = await x.run(
          x.custom.id,
          '请安装这个 ZIP 里的技能。如果有多个，先让我选一个。',
          await zip(true),
        );
        const pending = await broker(first);
        expect(pending.status).toBe('selection_required');
        await first.finish();
        if (operation === 'cancel') {
          const canceled = await x.run(
            x.custom.id,
            '刚才那个 ZIP 先不装了。',
            undefined,
            first.scope.sessionId,
          );
          const args = { importId: pending.importId, operation: 'cancel' };
          expect(await broker(canceled, args)).toMatchObject({
            status: 'canceled',
            installed: false,
          });
          expect(await broker(canceled, args)).toMatchObject({
            status: 'canceled',
          });
          await canceled.finish();
        } else
          await f.db`update allrice_personal_skill_imports set expires_at=clock_timestamp()-interval '1 second' where id=${pending.importId}`;
        const replay = await x.run(
          x.custom.id,
          '我选 weekly，请安装到当前员工。',
          undefined,
          first.scope.sessionId,
        );
        await expect(
          broker(replay, {
            importId: pending.importId,
            candidatePath: 'weekly/SKILL.md',
          }),
        ).rejects.toThrow();
        expect(await listPersonalSkills(x.context)).toEqual([]);
        await replay.finish();
      },
    );
    it.each(['expired', 'canceled'] as const)(
      'reclaims 32 %s imports and their private bytes before accepting another package',
      async (state) => {
        const x = await setup();
        const archive = await zip(true);
        const first = await x.run(
          x.custom.id,
          '请安装我上传的技能包。',
          archive,
        );
        const pending = await broker(first);
        await first.finish();
        const [original] =
          await f.db`select * from allrice_personal_skill_imports where id=${pending.importId}`;
        for (let index = 1; index < 32; index++) {
          const stored = await createStorageMetadata(x.context, {
            id: randomUUID(),
            workspaceId: x.source.workspaceId,
            category: 'memory',
            mediaType: 'application/zip',
            sizeBytes: archive.bytes.byteLength,
            checksum: skillBytesChecksum(archive.bytes),
            visibility: 'private',
            retentionUntil: null,
            immutable: false,
          });
          await assistantFixtureStorage(f.db).put(
            stored.object,
            new Blob([Buffer.from(archive.bytes)]).stream(),
          );
          await markStorageReady(x.context, stored.object.id);
          await f.db`insert into allrice_personal_skill_imports(id,organization_id,workspace_id,owner_id,instance_id,session_id,user_message_id,source,archive_object_id,candidates,state)
            values(${randomUUID()},${x.source.organizationId},${x.source.workspaceId},${x.source.ownerId},${x.custom.id},${first.scope.sessionId},${first.input.userMessageId},${f.db.json(original!.source)},${stored.object.id},${f.db.json(original!.candidates)},'ready')`;
        }
        const objects =
          await f.db`select object_key from allrice_storage_objects where owner_id=${x.source.ownerId} and category='memory'`;
        expect(objects).toHaveLength(32);
        if (state === 'expired')
          await f.db`update allrice_personal_skill_imports set expires_at=clock_timestamp()-interval '1 second' where owner_id=${x.source.ownerId}`;
        else
          await f.db`update allrice_personal_skill_imports set state='canceled' where owner_id=${x.source.ownerId}`;
        const next = await x.run(
          x.custom.id,
          '请安装我上传的技能包。',
          archive,
        );
        expect((await broker(next)).status).toBe('selection_required');
        const [count] =
          await f.db`select count(*)::int n from allrice_personal_skill_imports where owner_id=${x.source.ownerId} and state in ('ready','staging')`;
        expect(count!.n).toBe(1);
        const [quota] =
          await f.db`select sum(size_bytes)::int bytes from allrice_storage_objects where owner_id=${x.source.ownerId} and category='memory' and state<>'deleted'`;
        expect(quota!.bytes).toBe(archive.bytes.byteLength);
        for (const object of objects)
          await expect(
            access(join(f.storageRoot, object.object_key)),
          ).rejects.toThrow();
        await next.finish();
      },
      60000,
    );
    it('supersedes an older pending package before accepting a path shared by two imports', async () => {
      const x = await setup();
      const first = await x.run(
        x.custom.id,
        '请安装我上传的技能包。',
        await zip(true),
      );
      const older = await broker(first);
      await first.finish();
      const bytes = await createFileArchive([
        { path: 'weekly/SKILL.md', bytes: Buffer.from(raw('weekly-updated')) },
        {
          path: 'monthly/SKILL.md',
          bytes: Buffer.from(raw('monthly-updated')),
        },
      ]);
      const second = await x.run(
        x.custom.id,
        '请安装我上传的技能包。',
        { bytes, fileName: 'weekly.zip' },
        first.scope.sessionId,
      );
      const latest = await broker(second);
      await second.finish();
      const chosen = await x.run(
        x.custom.id,
        '安装 weekly/SKILL.md。',
        undefined,
        first.scope.sessionId,
      );
      await expect(
        broker(chosen, {
          importId: older.importId,
          candidatePath: 'weekly/SKILL.md',
        }),
      ).rejects.toThrow();
      expect(
        (
          await broker(chosen, {
            importId: latest.importId,
            candidatePath: 'weekly/SKILL.md',
          })
        ).skill.name,
      ).toBe('weekly-updated');
      expect((await listPersonalSkills(x.context)).map((s) => s.name)).toEqual([
        'weekly-updated',
      ]);
      await chosen.finish();
    });
    it('reuses one immutable archive across fresh uploads and employee bindings', async () => {
      const x = await setup();
      const archive = await zip();
      let versionId: string | undefined;
      for (const instanceId of [x.custom.id, x.custom.id, x.assignment.id]) {
        const task = await x.run(instanceId, '请安装我上传的技能包。', archive);
        const result = await broker(task);
        versionId ??= result.skill.versionId;
        expect(result.skill.versionId).toBe(versionId);
        await task.finish();
      }
      const objects =
        await f.db`select o.* from allrice_storage_objects o where owner_id=${x.source.ownerId} and category='memory'`;
      expect(objects).toHaveLength(1);
      expect(objects[0]).toMatchObject({ state: 'ready', immutable: true });
      const imports =
        await f.db`select archive_object_id,state from allrice_personal_skill_imports where owner_id=${x.source.ownerId}`;
      expect(imports).toHaveLength(3);
      expect(
        imports.every(
          (row) =>
            row.archive_object_id === objects[0]!.id &&
            row.state === 'consumed',
        ),
      ).toBe(true);
      expect((await listPersonalSkills(x.context))[0]!.bindings).toHaveLength(
        2,
      );
    });
    it.each(['python', 'javascript'] as const)(
      'resolves exact private %s bytes only from a current authorized Run',
      async (language) => {
        const x = await setup(true);
        const path =
          language === 'python' ? 'scripts/count.py' : 'scripts/count.mjs';
        const code =
          language === 'python'
            ? 'import json\nprint(json.dumps({"count":3}))\n'
            : 'console.log(JSON.stringify({count:3}));\n';
        const bytes = await createFileArchive([
          { path: 'SKILL.md', bytes: Buffer.from(raw('private-code')) },
          { path, bytes: Buffer.from(code) },
        ]);
        const first = await x.run(x.custom.id, '请安装我上传的技能包。', {
          bytes,
          fileName: 'compute.zip',
        });
        const installed = await broker(first);
        await first.finish();
        const next = await x.run(
          x.custom.id,
          '请运行 private-code 的固定脚本。',
        );
        const input = {
          context: next.input.context,
          sessionId: next.scope.sessionId,
          storageRoot: f.storageRoot,
          arguments: { frozenScript: { skill: 'private-code', path } },
        };
        expect(await resolveCloudToolArguments(input)).toMatchObject({
          language,
          script: code,
        });
        const [version] =
          await f.db`select definition from allrice_personal_skill_versions where id=${installed.skill.versionId}`;
        expect(version!.definition).not.toHaveProperty('requiredToolRefs');
        await expect(
          resolveCloudToolArguments({ ...input, sessionId: randomUUID() }),
        ).rejects.toThrow();
        await expect(
          resolveCloudToolArguments({
            ...input,
            arguments: {
              frozenScript: { skill: 'private-code', path },
              language: 'python',
            },
          }),
        ).rejects.toThrow();
        await expect(
          resolveCloudToolArguments({
            ...input,
            arguments: {
              frozenScript: {
                skill: 'private-code',
                path: 'references/count.py',
              },
            },
          }),
        ).rejects.toThrow();
        await managePersonalSkill(x.context, {
          workspaceId: x.source.workspaceId,
          instanceId: x.custom.id,
          installationId: installed.skill.id,
          expectedRevision: installed.skill.revision,
          requestId: randomUUID(),
          operation: 'disable',
        });
        await expect(resolveCloudToolArguments(input)).rejects.toThrow();
        await next.finish();
      },
    );
    it('retires the unused copy when two sessions stage the same ZIP before either installs', async () => {
      const x = await setup();
      const archive = await zip(true);
      const pending = [];
      for (let index = 0; index < 2; index++) {
        const task = await x.run(
          x.custom.id,
          '请安装我上传的技能包。',
          archive,
        );
        pending.push({
          ...(await broker(task)),
          sessionId: task.scope.sessionId,
        });
        await task.finish();
      }
      const before =
        await f.db`select object_key from allrice_storage_objects where owner_id=${x.source.ownerId} and category='memory'`;
      expect(before).toHaveLength(2);
      for (const entry of pending) {
        const task = await x.run(
          x.custom.id,
          '我选 weekly，请安装到当前员工。',
          undefined,
          entry.sessionId,
        );
        expect(
          await broker(task, {
            importId: entry.importId,
            candidatePath: 'weekly/SKILL.md',
          }),
        ).toMatchObject({ status: 'installed', cleanupPending: false });
        await task.finish();
      }
      const after =
        await f.db`select object_key,state,immutable from allrice_storage_objects where owner_id=${x.source.ownerId} and category='memory'`;
      expect(
        after.filter((row) => row.state === 'ready' && row.immutable),
      ).toHaveLength(1);
      const deleted = after.find((row) => row.state === 'deleted');
      expect(deleted).toBeDefined();
      await expect(
        access(join(f.storageRoot, deleted!.object_key)),
      ).rejects.toThrow();
      expect(await listPersonalSkills(x.context)).toHaveLength(1);
    });
    it('reports missing resources without an enabled or staged installation', async () => {
      const x = await setup();
      const bytes = await createFileArchive([
        {
          path: 'SKILL.md',
          bytes: Buffer.from(raw('incomplete') + 'Read references/missing.md.'),
        },
      ]);
      const task = await x.run(
        x.custom.id,
        '请安装我上传的 ZIP 里的技能，给当前 AI 员工使用。',
        { bytes, fileName: 'incomplete.zip' },
      );
      const result = await broker(task);
      expect(result).toMatchObject({
        status: 'incompatible',
        installed: false,
        candidates: [
          {
            issues: [
              { code: 'missing_resource', path: 'references/missing.md' },
            ],
          },
        ],
      });
      const [count] =
        await f.db`select count(*)::int n from allrice_personal_skill_imports where owner_id=${x.source.ownerId}`;
      expect(count!.n).toBe(0);
      expect(await listPersonalSkills(x.context)).toEqual([]);
      await task.finish();
    });
    it.each(['general', 'custom'] as const)(
      'installs through the real Broker handler for %s and freezes exact provenance without new grants',
      async (kind) => {
        const x = await setup(),
          instanceId = kind === 'general' ? x.assignment.id : x.custom.id;
        const { item } = await install(x, instanceId);
        expect(item.bindings).toMatchObject([
          { instanceId, enabled: true, epoch: 1 },
        ]);
        const next = await x.run(instanceId, '按个人技能检查这份交付。');
        const resolved = await resolveEmployeeExecution(next.scope);
        expect(resolved.executionSnapshot?.schemaVersion).toBe(2);
        if (resolved.executionSnapshot?.schemaVersion !== 2)
          throw Error('wrong snapshot');
        const snapshot = resolved.executionSnapshot;
        expect(snapshot.personalSkills?.skills[0]).toMatchObject({
          installationId: item.id,
          versionId: item.versionId,
        });
        assertFrozenPersonalSkills(
          snapshot.personalSkills,
          resolved.nativeSkills,
          instanceId,
        );
        assertFrozenBaseSkillCatalog(
          snapshot.baseSkillCatalog!,
          resolved.nativeSkills,
        );
        const privateSkill = resolved.nativeSkills.find((s) => s.personal)!;
        expect(privateSkill.requiredToolRefs).toEqual([]);
        expect(privateSkill.bundle).toBeUndefined();
        expect(privateSkill.content).not.toContain('---');
        const [version] =
          await f.db`select original_text,source from allrice_personal_skill_versions where id=${item.versionId}`;
        expect(version!.original_text).toBe(raw());
        expect(version!.source.originalChecksum).toBe(
          skillBytesChecksum(raw()),
        );
        await expect(
          f.db`update allrice_personal_skill_versions set original_text='changed' where id=${item.versionId}`,
        ).rejects.toThrow('immutable');
        const other = await x.run(
          kind === 'general' ? x.custom.id : x.assignment.id,
          'Unbound instance',
        );
        expect(
          (await resolveEmployeeExecution(other.scope)).nativeSkills.some(
            (s) => s.personal,
          ),
        ).toBe(false);
        await next.finish();
        await other.finish();
      },
    );
    it('revocation blocks loaded history, retry and re-enable of an old binding epoch', async () => {
      const x = await setup(),
        { item, task } = await install(x, x.custom.id);
      const old = await x.run(
        x.custom.id,
        'Use private skill',
        undefined,
        task.scope.sessionId,
      );
      const frozen = (await resolveEmployeeExecution(old.scope))
        .executionSnapshot;
      if (frozen?.schemaVersion !== 2) throw Error('wrong snapshot');
      await assertEmployeeContentContext(old.scope, old.runtime.generationId);
      const disabled = await managePersonalSkill(x.context, {
        workspaceId: x.source.workspaceId,
        instanceId: x.custom.id,
        installationId: item.id,
        expectedRevision: item.revision,
        requestId: randomUUID(),
        operation: 'disable',
      });
      await expect(
        assertEmployeeContentContext(old.scope, old.runtime.generationId),
      ).rejects.toThrow();
      await managePersonalSkill(x.context, {
        workspaceId: x.source.workspaceId,
        instanceId: x.custom.id,
        installationId: item.id,
        expectedRevision: disabled.revision,
        requestId: randomUUID(),
        operation: 'enable',
      });
      await expect(
        assertPersonalSkillsReadable(x.context, frozen.personalSkills, f.db),
      ).rejects.toThrow();
      await old.finish();
      const next = await x.run(
        x.custom.id,
        'Fresh task',
        undefined,
        old.scope.sessionId,
      );
      expect(next.runtime.generationId).not.toBe(old.runtime.generationId);
      expect(next.runtime.historyFromMessageId).toBe(next.input.userMessageId);
      expect(next.runtime.allowedMessageIds).not.toContain(
        old.input.userMessageId,
      );
      await next.finish();
    });
    it('does not install from quoted or temporary instructions, another attachment, or altered bytes', async () => {
      const x = await setup();
      const task = await x.run(
        x.custom.id,
        '请临时使用这个 SKILL.md，不要安装。',
        raw(),
      );
      await expect(preparePersonalSkillImport(task.input)).rejects.toThrow();
      await task.finish();
      const accepted = await x.run(
        x.custom.id,
        '请安装我上传的 SKILL.md。',
        raw(),
      );
      await expect(
        preparePersonalSkillImport({
          ...accepted.input,
          arguments: task.input.arguments,
        }),
      ).rejects.toThrow();
      await expect(
        installPersonalSkillFromChat(
          accepted.input,
          await parsePersonalSkill(Buffer.from(raw() + 'changed')),
        ),
      ).rejects.toThrow();
      expect(await listPersonalSkills(x.context)).toEqual([]);
      await accepted.finish();
    });
    it('does not enumerate or manage another owner and rejects damaged personal snapshot fallback', async () => {
      const x = await setup(),
        { item } = await install(x, x.custom.id);
      const p = await ensureBootstrapPortalPrincipal(
        {
          organizationSlug: `private-${randomUUID()}`,
          organizationName: 'Other test',
          workspaceSlug: 'default',
          workspaceName: 'Other test',
          email: `${randomUUID()}@example.test`,
          displayName: 'Other',
          role: 'member',
        },
        f.db,
      );
      const other = (await authenticateSession(
        (await createSession(p.user.id)).token,
        { organizationId: p.organizationId, workspaceId: p.workspaceId },
      ))!;
      expect(await listPersonalSkills(other)).toEqual([]);
      const sameCompany = await ensureBootstrapPortalPrincipal(
        {
          organizationSlug: `p18-${x.source.employeeId}`,
          organizationName: 'Synthetic publication',
          workspaceSlug: 'default',
          workspaceName: 'Synthetic publication',
          email: `${randomUUID()}@example.test`,
          displayName: 'Same company different person',
          role: 'member',
        },
        f.db,
      );
      const coworker = (await authenticateSession(
        (await createSession(sameCompany.user.id)).token,
        {
          organizationId: sameCompany.organizationId,
          workspaceId: sameCompany.workspaceId,
        },
      ))!;
      expect(await listPersonalSkills(coworker)).toEqual([]);
      await expect(
        managePersonalSkill(coworker, {
          workspaceId: x.source.workspaceId,
          instanceId: x.custom.id,
          installationId: item.id,
          expectedRevision: item.revision,
          requestId: randomUUID(),
          operation: 'disable',
        }),
      ).rejects.toThrow();
      await expect(
        managePersonalSkill(other, {
          workspaceId: x.source.workspaceId,
          instanceId: x.custom.id,
          installationId: item.id,
          expectedRevision: item.revision,
          requestId: randomUUID(),
          operation: 'uninstall',
        }),
      ).rejects.toThrow();
      const task = await x.run(x.custom.id, 'Use the installed skill');
      const resolved = await resolveEmployeeExecution(task.scope);
      expect(() =>
        assertFrozenPersonalSkills(
          undefined,
          resolved.nativeSkills,
          x.custom.id,
        ),
      ).toThrow();
      // Corruption fixture only, inside this test's generated private schema.
      await f.db.begin(async (tx) => {
        await tx`alter table allrice_employee_runs disable trigger allrice_employee_runs_snapshot_immutable`;
        await tx`update allrice_employee_runs set execution_snapshot=jsonb_set(execution_snapshot,'{personalSkills}', 'null') where run_id=${task.scope.runId}`;
        await tx`alter table allrice_employee_runs enable trigger allrice_employee_runs_snapshot_immutable`;
      });
      await expect(resolveEmployeeExecution(task.scope)).rejects.toThrow();
      await task.finish();
    });
    it('repeated installs are idempotent; uninstall is durable and an old receipt never re-enables', async () => {
      const x = await setup(),
        first = await install(x, x.custom.id),
        second = await install(x, x.custom.id);
      expect(second.item.id).toBe(first.item.id);
      expect(second.item.versionId).toBe(first.item.versionId);
      expect(second.item.revision).toBe(first.item.revision);
      const input = {
        workspaceId: x.source.workspaceId,
        instanceId: x.custom.id,
        installationId: first.item.id,
        expectedRevision: first.item.revision,
        requestId: randomUUID(),
        operation: 'uninstall',
      };
      const removed = await managePersonalSkill(x.context, input);
      expect(await managePersonalSkill(x.context, input)).toEqual(removed);
      expect(
        (await listPersonalSkills(x.context))[0]?.bindings[0]?.enabled,
      ).toBe(false);
      const next = await x.run(x.custom.id, 'Fresh after uninstall');
      expect(
        (await resolveEmployeeExecution(next.scope)).nativeSkills.some(
          (s) => s.personal,
        ),
      ).toBe(false);
      await next.finish();
    });
    it.each(['disable', 'uninstall'] as const)(
      'a new call ID from an old installation message cannot undo %s',
      async (operation) => {
        const x = await setup();
        const task = await x.run(
          x.custom.id,
          '请安装我上传的 SKILL.md。',
          raw(),
        );
        const parsed = await parsePersonalSkill(Buffer.from(raw()));
        const item = await installPersonalSkillFromChat(task.input, parsed);
        const retry = { ...task.input, callId: randomUUID() };
        expect((await installPersonalSkillFromChat(retry, parsed)).id).toBe(
          item.id,
        );
        await managePersonalSkill(x.context, {
          workspaceId: x.source.workspaceId,
          instanceId: x.custom.id,
          installationId: item.id,
          expectedRevision: item.revision,
          requestId: randomUUID(),
          operation,
        });
        await expect(preparePersonalSkillImport(retry)).rejects.toThrow(
          'conflict',
        );
        await expect(
          installPersonalSkillFromChat(retry, parsed),
        ).rejects.toThrow('conflict');
        expect(
          (await listPersonalSkills(x.context))[0]?.bindings[0]?.enabled,
        ).toBe(false);
        await task.finish();
        const fresh = await install(x, x.custom.id);
        expect(fresh.item.versionId).toBe(item.versionId);
        expect(fresh.item.state).toBe('installed');
        expect(fresh.item.bindings[0].enabled).toBe(true);
      },
    );
    it('rejects a previously prepared message after revocation, even without an installation receipt', async () => {
      const x = await setup(),
        { item } = await install(x, x.custom.id);
      const waiting = await x.run(
        x.custom.id,
        '请安装我上传的 SKILL.md。',
        raw(),
      );
      await preparePersonalSkillImport(waiting.input);
      await managePersonalSkill(x.context, {
        workspaceId: x.source.workspaceId,
        instanceId: x.custom.id,
        installationId: item.id,
        expectedRevision: item.revision,
        requestId: randomUUID(),
        operation: 'disable',
      });
      await expect(
        installPersonalSkillFromChat(
          waiting.input,
          await parsePersonalSkill(Buffer.from(raw())),
        ),
      ).rejects.toThrow('conflict');
      await waiting.finish();
    });
    it.each(['archive', 'withdraw'])(
      'can uninstall an owned installation after instance %s without a live binding',
      async (operation) => {
        const x = await setup(),
          { item } = await install(x, x.custom.id);
        if (operation === 'archive')
          await f.db`update allrice_employee_instances set archived_at=clock_timestamp() where id=${x.custom.id}`;
        else
          await f.db`update allrice_employee_assignments set active=false where id=${x.assignment.id}`;
        expect((await listPersonalSkills(x.context))[0]?.bindings).toEqual([]);
        expect(
          (
            await managePersonalSkill(x.context, {
              workspaceId: x.source.workspaceId,
              installationId: item.id,
              expectedRevision: item.revision,
              requestId: randomUUID(),
              operation: 'uninstall',
            })
          ).state,
        ).toBe('uninstalled');
        const [row] =
          await f.db`select count(*)::int n from allrice_personal_skill_bindings where installation_id=${item.id} and enabled`;
        expect(row!.n).toBe(0);
      },
    );
    it.each(['null', 'missing'])(
      'isolates old personal history with a %s index from both new tasks and imports',
      async (corruption) => {
        const x = await setup(),
          { item } = await install(x, x.custom.id);
        const old = await x.run(x.custom.id, 'Use the private checklist');
        await old.finish();
        // Only this test's isolated generated schema can change immutable fixtures.
        await f.db.begin(async (tx) => {
          await tx`alter table allrice_employee_runs disable trigger allrice_employee_runs_snapshot_immutable`;
          if (corruption === 'null')
            await tx`update allrice_employee_runs set execution_snapshot=jsonb_set(execution_snapshot,'{personalSkills}','null') where run_id=${old.scope.runId}`;
          else
            await tx`update allrice_employee_runs set execution_snapshot=execution_snapshot-'personalSkills' where run_id=${old.scope.runId}`;
          await tx`alter table allrice_employee_runs enable trigger allrice_employee_runs_snapshot_immutable`;
        });
        await expect(
          assertEmployeeContentReferenceMessages(
            x.context,
            old.scope.sessionId,
            [old.input.userMessageId],
            f.db,
          ),
        ).rejects.toThrow();
        await managePersonalSkill(x.context, {
          workspaceId: x.source.workspaceId,
          instanceId: x.custom.id,
          installationId: item.id,
          expectedRevision: item.revision,
          requestId: randomUUID(),
          operation: 'disable',
        });
        const next = await x.run(
          x.custom.id,
          'Fresh task',
          undefined,
          old.scope.sessionId,
        );
        expect(next.runtime.generationId).not.toBe(old.runtime.generationId);
        expect(next.runtime.historyFromMessageId).toBe(
          next.input.userMessageId,
        );
        expect(next.runtime.allowedMessageIds).not.toContain(
          old.input.userMessageId,
        );
        await next.finish();
      },
    );
    it('refuses platform-name replacement and rechecks the current assignment before committing import', async () => {
      const x = await setup();
      const text = raw(`p18-${x.source.skillId}`);
      const task = await x.run(x.custom.id, '请安装我上传的 SKILL.md。', text);
      await expect(
        installPersonalSkillFromChat(
          task.input,
          await parsePersonalSkill(Buffer.from(text)),
        ),
      ).rejects.toThrow('name_conflict');
      await task.finish();
      const second = await x.run(
        x.custom.id,
        '请安装我上传的 SKILL.md。',
        raw(),
      );
      expect(await preparePersonalSkillImport(second.input)).toMatchObject({
        instanceId: x.custom.id,
      });
      await f.db`update allrice_employee_assignments set active=false where id=${x.assignment.id}`;
      await expect(
        installPersonalSkillFromChat(
          second.input,
          await parsePersonalSkill(Buffer.from(raw())),
        ),
      ).rejects.toThrow();
      expect(await listPersonalSkills(x.context)).toEqual([]);
      await second.finish();
    });
  },
);
