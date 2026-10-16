import { createHash, randomUUID } from 'node:crypto';
import { access, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { PersonalSkillItemSchema } from '@allrice/contracts';
import { employeeChatUuid } from './employee-chat-authority.ts';
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
import {
  savePlatformEmployeeDraft,
  assignPublishedPlatformEmployeeToWorkspace,
} from './platform-employees.ts';
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
import { LocalStorageAdapter } from '../../../storage/src/index.ts';

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
            name:
              'operation' in args && !('importId' in args)
                ? 'workspace.personal_skill.version'
                : 'workspace.personal_skill.install',
            arguments: args,
          },
          managedBrowserJobAttempt: task.input.worker.attempt,
          managedBrowserJobLeaseToken: task.input.worker.leaseToken,
        },
      });
      return JSON.parse(result.modelContent);
    }
    it('updates original bytes through the Broker, confirms next-task adoption, and rolls back without altering old Run pins', async () => {
      const x = await setup();
      const initial = await x.run(
        x.custom.id,
        '请安装我上传的 SKILL.md。',
        raw('weekly'),
      );
      const v1 = (await broker(initial)).skill;
      await initial.finish();
      const old = await x.run(x.custom.id, '按 weekly 检查。');
      const oldFrozen = await resolveEmployeeExecution(old.scope);
      await old.finish();
      const second = raw('weekly').replace(
        'Use three items: source, calculation, delivery.',
        'Use four items: source, calculation, delivery, owner.',
      );
      const updating = await x.run(
        x.custom.id,
        '请将 weekly 更新为我上传的 SKILL.md。后续任务请使用新版本。',
        second,
      );
      const args = {
        operation: 'update',
        installationId: v1.id,
        expectedRevision: v1.revision,
        objectId: updating.input.arguments.objectId,
      };
      const preview = await broker(updating, args);
      expect(preview).toMatchObject({
        status: 'confirmation_required',
        fromVersion: 1,
        targetVersion: 2,
        bindings: [{ enabled: true, epoch: 1 }],
      });
      expect((await listPersonalSkills(x.context))[0]!.version).toBe(1);
      expect((await broker(updating, args)).operationId).toBe(
        preview.operationId,
      );
      const confirmation = {
        operation: 'confirm',
        operationId: preview.operationId,
        digest: preview.digest,
      };
      await expect(broker(updating, confirmation)).rejects.toThrow();
      await updating.finish();
      const approved = await x.run(
        x.custom.id,
        preview.confirmationText,
        undefined,
        updating.scope.sessionId,
      );
      const applied = await broker(approved, confirmation);
      expect(applied).toMatchObject({
        status: 'applied',
        targetVersion: 2,
        appliedRevision: 2,
      });
      expect(await broker(approved, confirmation)).toEqual(applied);
      expect((await listPersonalSkills(x.context))[0]).toMatchObject({
        version: 2,
        bindings: [{ epoch: 1, enabled: true }],
      });
      await approved.finish();
      const next = await x.run(x.custom.id, '按 weekly 新版本检查。');
      const updated = await resolveEmployeeExecution(next.scope);
      expect(
        updated.nativeSkills.find((s) => s.name === 'weekly')?.content,
      ).toContain('four items');
      expect(
        oldFrozen.nativeSkills.find((s) => s.name === 'weekly')?.content,
      ).toContain('three items');
      await next.finish();
      const restoring = await x.run(x.custom.id, '请将 weekly 回退到 v1。');
      const restore = await broker(restoring, {
        operation: 'rollback',
        installationId: v1.id,
        expectedRevision: 2,
        version: 1,
      });
      expect(restore).toMatchObject({
        status: 'confirmation_required',
        fromVersion: 2,
        targetVersion: 1,
      });
      await restoring.finish();
      const confirm = await x.run(
        x.custom.id,
        restore.confirmationText,
        undefined,
        restoring.scope.sessionId,
      );
      expect(
        await broker(confirm, {
          operation: 'confirm',
          operationId: restore.operationId,
          digest: restore.digest,
        }),
      ).toMatchObject({
        status: 'applied',
        targetVersion: 1,
        appliedRevision: 3,
      });
      await confirm.finish();
      const back = await x.run(x.custom.id, '按 weekly 再次检查。');
      expect(
        (await resolveEmployeeExecution(back.scope)).nativeSkills.find(
          (s) => s.name === 'weekly',
        )?.content,
      ).toContain('three items');
      const history = await broker(back, {
        operation: 'inspect',
        installationId: v1.id,
      });
      expect(
        history.versions.map((v: { version: number; current: boolean }) => [
          v.version,
          v.current,
        ]),
      ).toEqual([
        [2, false],
        [1, true],
      ]);
      expect(
        (
          await f.db`select count(*)::int n from allrice_personal_skill_versions where installation_id=${v1.id}`
        )[0]!.n,
      ).toBe(2);
      await back.finish();
    });
    it('keeps disabled bindings disabled, rejects a stale impact and exposes original install receipts after a later update', async () => {
      const x = await setup();
      const original = await x.run(
        x.custom.id,
        '请安装我上传的 SKILL.md。',
        raw('weekly'),
      );
      const first = (await broker(original)).skill;
      // Keep this real leased root active to exercise unknown-outcome readback.
      const pending = await x.run(
        x.custom.id,
        '请将 weekly 更新为 SKILL.md。',
        raw('weekly') + 'Check owner.',
      );
      const preview = await broker(pending, {
        operation: 'update',
        installationId: first.id,
        expectedRevision: first.revision,
        objectId: pending.input.arguments.objectId,
      });
      await pending.finish();
      const another = await createEmployeeInstance(x.context, {
        workspaceId: x.source.workspaceId,
        assignmentId: x.assignment.id,
        requestId: randomUUID(),
        profile: { name: 'Second tester' },
      });
      const binding = await x.run(
        another.id,
        '请把个人技能 weekly 启用给当前 AI 员工。',
      );
      const bound = await broker(binding, {
        operation: 'bind',
        installationId: first.id,
        expectedRevision: first.revision,
        versionId: first.versionId,
      });
      expect(bound.status).toBe('bound');
      await binding.finish();
      const stale = await x.run(
        x.custom.id,
        preview.confirmationText,
        undefined,
        pending.scope.sessionId,
      );
      await expect(
        broker(stale, {
          operation: 'confirm',
          operationId: preview.operationId,
          digest: preview.digest,
        }),
      ).rejects.toThrow();
      expect((await listPersonalSkills(x.context))[0]!.version).toBe(1);
      await stale.finish();
      const disabled = await managePersonalSkill(x.context, {
        workspaceId: x.source.workspaceId,
        instanceId: another.id,
        installationId: first.id,
        expectedRevision: bound.current.revision,
        requestId: randomUUID(),
        operation: 'disable',
      });
      const update = await x.run(
        x.custom.id,
        '请将 weekly 更新为 SKILL.md。',
        raw('weekly') + 'Check owner.',
      );
      const second = await broker(update, {
        operation: 'update',
        installationId: first.id,
        expectedRevision: disabled.revision,
        objectId: update.input.arguments.objectId,
      });
      expect(second.bindings).toHaveLength(2);
      expect(
        second.bindings.find(
          (b: { instanceId: string }) => b.instanceId === another.id,
        ),
      ).toMatchObject({ enabled: false, epoch: 2 });
      await update.finish();
      const wrongSession = await x.run(x.custom.id, second.confirmationText);
      await expect(
        broker(wrongSession, {
          operation: 'confirm',
          operationId: second.operationId,
          digest: second.digest,
        }),
      ).rejects.toThrow();
      await wrongSession.finish();
      const yes = await x.run(
        x.custom.id,
        second.confirmationText,
        undefined,
        update.scope.sessionId,
      );
      const result = await broker(yes, {
        operation: 'confirm',
        operationId: second.operationId,
        digest: second.digest,
      });
      expect(result.status).toBe('applied');
      expect(
        (await listPersonalSkills(x.context))[0]!.bindings.find(
          (b) => b.instanceId === another.id,
        ),
      ).toMatchObject({ enabled: false, epoch: 2 });
      const readback = await broker(original);
      expect(readback.skill.versionId).toBe(first.versionId);
      expect(readback.currentSkill.version).toBe(2);
      expect(
        (
          await f.db`select count(*)::int n from allrice_personal_skill_versions where installation_id=${first.id}`
        )[0]!.n,
      ).toBe(2);
      await yes.finish();
      await original.finish();
    });
    it('retains exact ZIP versions, checks bytes before rollback, and leaves the current version on missing archive', async () => {
      const x = await setup();
      const first = await x.run(
        x.custom.id,
        '请安装我上传的技能包。',
        await zip(),
      );
      const installed = (await broker(first)).skill;
      await first.finish();
      const second = await x.run(
        x.custom.id,
        '请将 weekly 更新为 weekly.zip。',
        {
          fileName: 'weekly.zip',
          bytes: await createFileArchive([
            {
              path: 'weekly/SKILL.md',
              bytes: Buffer.from(raw('weekly') + 'Read references/check.md.'),
            },
            {
              path: 'weekly/references/check.md',
              bytes: Buffer.from('V2 exact private reference'),
            },
          ]),
        },
      );
      const update = await broker(second, {
        operation: 'update',
        installationId: installed.id,
        expectedRevision: installed.revision,
        objectId: second.input.arguments.objectId,
      });
      await second.finish();
      const yes = await x.run(
        x.custom.id,
        update.confirmationText,
        undefined,
        second.scope.sessionId,
      );
      const applied = await broker(yes, {
        operation: 'confirm',
        operationId: update.operationId,
        digest: update.digest,
      });
      expect(applied.status).toBe('applied');
      await yes.finish();
      const rollback = await x.run(x.custom.id, '请将 weekly 回退到 v1。');
      const back = await broker(rollback, {
        operation: 'rollback',
        installationId: installed.id,
        expectedRevision: applied.appliedRevision,
        version: 1,
      });
      await rollback.finish();
      const [stored] =
        await f.db`select o.object_key from allrice_personal_skill_versions v join allrice_storage_objects o on o.id=(v.resource_manifest->>'archiveObjectId')::uuid where v.id=${installed.versionId}`;
      await unlink(join(f.storageRoot, stored!.object_key));
      const confirm = await x.run(
        x.custom.id,
        back.confirmationText,
        undefined,
        rollback.scope.sessionId,
      );
      await expect(
        broker(confirm, {
          operation: 'confirm',
          operationId: back.operationId,
          digest: back.digest,
        }),
      ).rejects.toThrow();
      expect((await listPersonalSkills(x.context))[0]!.version).toBe(2);
      await confirm.finish();
    });
    it('includes disabled bindings in another authorized workspace and refuses incomplete scope after access removal', async () => {
      const x = await setup();
      const first = await x.run(
        x.custom.id,
        '请安装我上传的 SKILL.md。',
        raw('weekly'),
      );
      const skill = (await broker(first)).skill;
      await first.finish();
      const workspaceId = randomUUID();
      await f.db`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspaceId},${x.source.organizationId},'second','Second authorized workspace')`;
      await f.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${x.source.organizationId},${workspaceId},${x.source.ownerId},'member')`;
      const [platform] =
        await f.db`select employee_key from allrice_platform_employees where id=${x.source.employeeId}`;
      await assignPublishedPlatformEmployeeToWorkspace(
        platform!.employee_key,
        workspaceId,
      );
      const context = (await authenticateSession(
        (await createSession(x.source.ownerId)).token,
        { organizationId: x.source.organizationId, workspaceId },
      ))!;
      const assigned = (await getEmployeeWorkspace(context, workspaceId))
        .employees[0]!;
      const other = await createEmployeeInstance(context, {
        workspaceId,
        assignmentId: assigned.id,
        requestId: randomUUID(),
        profile: { name: 'Other workspace tester' },
      });
      await f.db`insert into allrice_personal_skill_bindings(organization_id,workspace_id,owner_id,instance_id,installation_id,enabled)
        values(${x.source.organizationId},${workspaceId},${x.source.ownerId},${other.id},${skill.id},false)`;
      const update = await x.run(
        x.custom.id,
        '请将 weekly 更新为 SKILL.md。',
        raw('weekly') + 'Verify totals.',
      );
      const preview = await broker(update, {
        operation: 'update',
        installationId: skill.id,
        expectedRevision: skill.revision,
        objectId: update.input.arguments.objectId,
      });
      expect(preview.bindings).toHaveLength(2);
      expect(
        preview.bindings.find(
          (b: { workspaceId: string }) => b.workspaceId === workspaceId,
        ),
      ).toMatchObject({
        enabled: false,
        workspaceLabel: 'Second authorized workspace',
      });
      expect((await listPersonalSkills(x.context))[0]!.bindings).toHaveLength(
        1,
      );
      await update.finish();
      await f.db`delete from allrice_memberships where organization_id=${x.source.organizationId} and workspace_id=${workspaceId} and user_id=${x.source.ownerId}`;
      const confirm = await x.run(
        x.custom.id,
        preview.confirmationText,
        undefined,
        update.scope.sessionId,
      );
      await expect(
        broker(confirm, {
          operation: 'confirm',
          operationId: preview.operationId,
          digest: preview.digest,
        }),
      ).rejects.toThrow();
      expect((await listPersonalSkills(x.context))[0]!.version).toBe(1);
      await confirm.finish();
    });
    it('requires fresh bind authority after revocation even if an old Run refreshes revision', async () => {
      const x = await setup();
      const { item } = await install(x, x.custom.id);
      const other = await createEmployeeInstance(x.context, {
        workspaceId: x.source.workspaceId,
        assignmentId: x.assignment.id,
        requestId: randomUUID(),
        profile: { name: 'Bind tester' },
      });
      const old = await x.run(
        other.id,
        '请把技能 private-checklist 绑定给你。',
      );
      const args = {
        operation: 'bind',
        installationId: item.id,
        expectedRevision: item.revision,
        versionId: item.versionId,
      };
      const applied = await broker(old, args);
      const stopped = await managePersonalSkill(x.context, {
        workspaceId: x.source.workspaceId,
        instanceId: other.id,
        installationId: item.id,
        expectedRevision: applied.current.revision,
        requestId: randomUUID(),
        operation: 'disable',
      });
      const readback = await broker(old, args);
      expect(
        readback.current.bindings.find(
          (b: { instanceId: string }) => b.instanceId === other.id,
        ).enabled,
      ).toBe(false);
      await expect(
        broker(old, { ...args, expectedRevision: stopped.revision }),
      ).rejects.toThrow();
      expect(
        (await listPersonalSkills(x.context))[0]!.bindings.find(
          (b) => b.instanceId === other.id,
        )?.enabled,
      ).toBe(false);
      await old.finish();
      const fresh = await x.run(
        other.id,
        '请把技能 private-checklist 绑定给你。',
      );
      expect(
        (
          await broker(fresh, { ...args, expectedRevision: stopped.revision })
        ).current.bindings.find(
          (b: { instanceId: string }) => b.instanceId === other.id,
        ).enabled,
      ).toBe(true);
      await fresh.finish();
    });
    it('lets only the most recent same-session candidate consume a generic fixed-version confirmation', async () => {
      const x = await setup();
      const { item } = await install(x, x.custom.id);
      const first = await x.run(
        x.custom.id,
        '请将 private-checklist 更新为 SKILL.md。',
        raw() + 'Candidate A.',
      );
      const a = await broker(first, {
        operation: 'update',
        installationId: item.id,
        expectedRevision: item.revision,
        objectId: first.input.arguments.objectId,
      });
      await first.finish();
      const second = await x.run(
        x.custom.id,
        '请将 private-checklist 更新为 SKILL.md。',
        raw() + 'Candidate B.',
        first.scope.sessionId,
      );
      const b = await broker(second, {
        operation: 'update',
        installationId: item.id,
        expectedRevision: item.revision,
        objectId: second.input.arguments.objectId,
      });
      await second.finish();
      const yes = await x.run(
        x.custom.id,
        b.confirmationText,
        undefined,
        second.scope.sessionId,
      );
      expect(
        (
          await broker(yes, {
            operation: 'confirm',
            operationId: a.operationId,
            digest: a.digest,
          })
        ).status,
      ).toBe('canceled');
      expect((await listPersonalSkills(x.context))[0]!.version).toBe(1);
      const applied = await broker(yes, {
        operation: 'confirm',
        operationId: b.operationId,
        digest: b.digest,
      });
      expect(applied.status).toBe('applied');
      const [v] =
        await f.db`select original_text from allrice_personal_skill_versions where id=${applied.appliedVersionId}`;
      expect(v!.original_text).toContain('Candidate B.');
      await yes.finish();
    });
    it('keeps pre-version-management installation and staging keys stable', async () => {
      const x = await setup();
      const first = await x.run(
        x.custom.id,
        '请安装我上传的 SKILL.md。',
        raw(),
      );
      const installed = (await broker(first)).skill;
      const oldId = employeeChatUuid(
        'personal-skill-install',
        x.source.organizationId,
        x.source.ownerId,
        first.input.userMessageId,
        first.input.arguments.objectId,
        x.custom.id,
      );
      const [receipt] =
        await f.db`select response from allrice_personal_skill_receipts where request_id=${oldId}`;
      expect(receipt!.response.versionId).toBe(installed.versionId);
      expect((await broker(first)).skill.versionId).toBe(installed.versionId);
      await first.finish();
      const url = 'https://github.com/acme/skills';
      const pending = await x.run(x.custom.id, `请安装 ${url} 里的技能。`);
      const source = publicGitHub(true);
      try {
        const result = await broker(pending, { url });
        const key = employeeChatUuid(
          'personal-skill-install',
          x.source.organizationId,
          x.source.ownerId,
          pending.input.userMessageId,
          `url:${url}`,
          x.custom.id,
        );
        expect(result.importId).toBe(key);
        const count = source.fetch.mock.calls.length;
        source.move();
        expect((await broker(pending, { url })).importId).toBe(key);
        expect(source.fetch).toHaveBeenCalledTimes(count);
        await pending.finish();
      } finally {
        source.fetch.mockRestore();
      }
    });
    it('rejects a new binding that would collide with that employee native platform skill', async () => {
      const x = await setup();
      const different = await createEmployeeAdministrationFixture(f.db);
      await different.preview();
      expect((await different.publish()).valid).toBe(true);
      const [skill] =
        await f.db`select name from allrice_platform_dsh_skills where id=${different.skillId}`;
      const first = await x.run(
        x.custom.id,
        '请安装我上传的 SKILL.md。',
        raw(skill!.name),
      );
      const item = (await broker(first)).skill;
      await first.finish();
      const [platform] =
        await f.db`select employee_key from allrice_platform_employees where id=${different.employeeId}`;
      await assignPublishedPlatformEmployeeToWorkspace(
        platform!.employee_key,
        x.source.workspaceId,
      );
      const employees = (
        await getEmployeeWorkspace(x.context, x.source.workspaceId)
      ).employees;
      const assignment = employees.find((e) => e.id !== x.assignment.id)!;
      const task = await x.run(
        assignment.id,
        `请把技能 ${skill!.name} 绑定给你。`,
      );
      await expect(
        broker(task, {
          operation: 'bind',
          installationId: item.id,
          expectedRevision: item.revision,
          versionId: item.versionId,
        }),
      ).rejects.toThrow();
      expect((await listPersonalSkills(x.context))[0]!.bindings).toHaveLength(
        1,
      );
      await task.finish();
    });
    it('does not publish through a concurrent archive of another affected employee', async () => {
      const x = await setup();
      const { item } = await install(x, x.custom.id);
      const other = await createEmployeeInstance(x.context, {
        workspaceId: x.source.workspaceId,
        assignmentId: x.assignment.id,
        requestId: randomUUID(),
        profile: { name: 'Concurrent archive target' },
      });
      const bind = await x.run(
        other.id,
        '请把技能 private-checklist 绑定给你。',
      );
      const bound = await broker(bind, {
        operation: 'bind',
        installationId: item.id,
        expectedRevision: item.revision,
        versionId: item.versionId,
      });
      await bind.finish();
      const update = await x.run(
        x.custom.id,
        '请将 private-checklist 更新为 SKILL.md。',
        raw() + 'Locked scope.',
      );
      const preview = await broker(update, {
        operation: 'update',
        installationId: item.id,
        expectedRevision: bound.current.revision,
        objectId: update.input.arguments.objectId,
      });
      await update.finish();
      const confirm = await x.run(
        x.custom.id,
        preview.confirmationText,
        undefined,
        update.scope.sessionId,
      );
      let release!: () => void, ready!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const acquired = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const archive = f.db.begin(async (tx) => {
        await tx`update allrice_employee_instances set archived_at=clock_timestamp(),revision=revision+1 where id=${other.id}`;
        ready();
        await gate;
      });
      await acquired;
      const args = {
        operation: 'confirm',
        operationId: preview.operationId,
        digest: preview.digest,
      };
      try {
        await expect(broker(confirm, args)).rejects.toThrow();
      } finally {
        release();
        await archive;
      }
      await expect(broker(confirm, args)).rejects.toThrow();
      expect((await listPersonalSkills(x.context))[0]!.versionId).toBe(
        item.versionId,
      );
      await confirm.finish();
    });
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
    function publicGitHub(multiple = false) {
      const commit = 'a'.repeat(40),
        tree = 'b'.repeat(40);
      let movingRef = commit;
      const files = new Map([
        [
          'weekly/SKILL.md',
          raw('weekly') +
            'Read references/checklist.md and assets/report.md.\n',
        ],
        ['weekly/references/checklist.md', 'Exact public reference.'],
        ['weekly/assets/report.md', '# Exact report template\n'],
        ['weekly/assets/example/SKILL.md', raw('template-only')],
        ...(multiple ? [['monthly/SKILL.md', raw('monthly')]] : []),
      ] as [string, string][]);
      const entries = [...files].map(([path, text]) => ({
        path,
        type: 'blob',
        mode: '100644',
        size: Buffer.byteLength(text),
        sha: createHash('sha1')
          .update(`blob ${Buffer.byteLength(text)}\0`)
          .update(text)
          .digest('hex'),
      }));
      const json = (value: unknown) => new Response(JSON.stringify(value));
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (address, options) => {
          expect(options?.method).toBe('GET');
          expect(options?.redirect).toBe('manual');
          expect(new Headers(options?.headers).has('authorization')).toBe(
            false,
          );
          const url = new URL(String(address));
          if (url.hostname === 'raw.githubusercontent.com') {
            expect(url.pathname.split('/')[3]).toBe(commit);
            const path = url.pathname
              .split('/')
              .slice(4)
              .map(decodeURIComponent)
              .join('/');
            return files.has(path)
              ? new Response(files.get(path))
              : new Response(null, { status: 404 });
          }
          expect(url.hostname).toBe('api.github.com');
          if (url.pathname === '/repos/acme/skills')
            return json({
              private: false,
              full_name: 'acme/skills',
              default_branch: 'main',
            });
          if (url.pathname.startsWith('/repos/acme/skills/commits/')) {
            const ref = decodeURIComponent(
              url.pathname.slice('/repos/acme/skills/commits/'.length),
            );
            return ref === 'main' || ref === commit
              ? json({
                  sha: ref === 'main' ? movingRef : commit,
                  commit: { tree: { sha: tree } },
                })
              : new Response(null, { status: 404 });
          }
          if (url.pathname === `/repos/acme/skills/git/trees/${tree}`)
            return json({
              sha: tree,
              truncated: false,
              tree: [
                {
                  path: 'weekly',
                  mode: '040000',
                  type: 'tree',
                  sha: 'c'.repeat(40),
                },
                ...entries,
              ],
            });
          throw Error('Unexpected public source request');
        });
      return {
        fetch,
        files,
        commit,
        tree,
        move: () => {
          movingRef = 'e'.repeat(40);
        },
      };
    }
    it('stages a fixed public update by exact installed name and never refetches it after source movement', async () => {
      const x = await setup();
      const first = await x.run(
        x.custom.id,
        '请安装我上传的 SKILL.md。',
        raw('weekly'),
      );
      const skill = (await broker(first)).skill;
      await first.finish();
      const url = 'https://github.com/acme/skills';
      const task = await x.run(x.custom.id, `请将 weekly 更新为 ${url}。`);
      const source = publicGitHub(true);
      try {
        const args = {
          operation: 'update',
          installationId: skill.id,
          expectedRevision: skill.revision,
          url,
        };
        const preview = await broker(task, args);
        expect(preview).toMatchObject({
          status: 'confirmation_required',
          source: {
            commitSha: source.commit,
            candidatePath: 'weekly/SKILL.md',
          },
        });
        const requests = source.fetch.mock.calls.length;
        source.move();
        expect((await broker(task, args)).operationId).toBe(
          preview.operationId,
        );
        expect(source.fetch).toHaveBeenCalledTimes(requests);
        await task.finish();
        const yes = await x.run(
          x.custom.id,
          preview.confirmationText,
          undefined,
          task.scope.sessionId,
        );
        const result = await broker(yes, {
          operation: 'confirm',
          operationId: preview.operationId,
          digest: preview.digest,
        });
        expect(result).toMatchObject({
          status: 'applied',
          targetVersion: 2,
          source: { commitSha: source.commit },
        });
        expect(source.fetch).toHaveBeenCalledTimes(requests);
        const [v] =
          await f.db`select original_text,source from allrice_personal_skill_versions where id=${result.appliedVersionId}`;
        expect(v!.original_text).toBe(source.files.get('weekly/SKILL.md'));
        expect(v!.source.commitSha).toBe(source.commit);
        await yes.finish();
      } finally {
        source.fetch.mockRestore();
      }
    });
    it('imports a pinned public source through the real Broker and native parser, then reuses private resources without another download', async () => {
      const x = await setup(),
        url = 'https://github.com/acme/skills/tree/main/weekly';
      const task = await x.run(x.custom.id, `请安装这个技能：\n${url}`);
      const publicSource = publicGitHub();
      try {
        const installed = await broker(task, { url });
        expect(installed.status).toBe('installed');
        expect(installed.skill).toMatchObject({
          resourceCount: 3,
          source: {
            kind: 'github',
            requestedUrl: url,
            commitSha: publicSource.commit,
            treeSha: publicSource.tree,
          },
        });
        const requests = publicSource.fetch.mock.calls.length;
        expect((await broker(task, { url })).skill.versionId).toBe(
          installed.skill.versionId,
        );
        expect(publicSource.fetch).toHaveBeenCalledTimes(requests);
        const [stored] =
          await f.db`select v.source,v.original_text,o.visibility,o.immutable from allrice_personal_skill_versions v
          join allrice_storage_objects o on o.id=(v.resource_manifest->>'archiveObjectId')::uuid where v.id=${installed.skill.versionId}`;
        expect(stored).toMatchObject({
          original_text: publicSource.files.get('weekly/SKILL.md'),
          visibility: 'private',
          immutable: true,
        });
        await task.finish();
        publicSource.fetch.mockImplementation(async () => {
          throw Error('Source now unavailable');
        });
        const next = await x.run(x.custom.id, '按 weekly 参考写报告。');
        const resolved = await resolveEmployeeExecution(next.scope);
        const args = { skill: 'weekly', path: 'assets/example/SKILL.md' };
        const response = await readSkillResource({
          arguments: args,
          input: {
            context: next.input.context,
            sessionId: next.scope.sessionId,
            storageRoot: f.storageRoot,
            nativeSkills: resolved.nativeSkills,
            capabilities: ['storage:read'],
            call: {
              id: randomUUID(),
              name: 'workspace.skill.read',
              arguments: args,
            },
          },
        });
        expect(JSON.parse(response.modelContent)).toMatchObject({
          text: raw('template-only'),
          versionId: installed.skill.versionId,
        });
        expect(publicSource.fetch).toHaveBeenCalledTimes(requests);
        await next.finish();
      } finally {
        publicSource.fetch.mockRestore();
      }
    });
    it('keeps a public multi-skill selection pinned across a moving ref and requires a new user message', async () => {
      const x = await setup(),
        url = 'https://github.com/acme/skills';
      const first = await x.run(x.custom.id, `请安装 ${url} 里的技能。`);
      const source = publicGitHub(true);
      try {
        const pending = await broker(first, { url });
        expect(pending.status).toBe('selection_required');
        expect(
          pending.candidates.map((c: { name: string }) => c.name).sort(),
        ).toEqual(['monthly', 'weekly']);
        const requests = source.fetch.mock.calls.length;
        source.move();
        expect((await broker(first, { url })).importId).toBe(pending.importId);
        expect(source.fetch).toHaveBeenCalledTimes(requests);
        expect(await listPersonalSkills(x.context)).toEqual([]);
        const args = {
          importId: pending.importId,
          candidatePath: 'weekly/SKILL.md',
        };
        await expect(broker(first, args)).rejects.toThrow();
        await first.finish();
        const next = await x.run(
          x.custom.id,
          '我选 weekly，请安装到当前员工。',
          undefined,
          first.scope.sessionId,
        );
        const result = await broker(next, args);
        expect(result.skill.source.commitSha).toBe(source.commit);
        expect(source.fetch).toHaveBeenCalledTimes(requests);
        await next.finish();
      } finally {
        source.fetch.mockRestore();
      }
    });
    it('recovers a staged public archive with its original commit after an unknown storage write outcome', async () => {
      const x = await setup(),
        url = 'https://github.com/acme/skills/tree/main/weekly';
      const task = await x.run(x.custom.id, `请安装 ${url} 里的技能。`);
      const source = publicGitHub(),
        originalPut = LocalStorageAdapter.prototype.put;
      const put = vi
        .spyOn(LocalStorageAdapter.prototype, 'put')
        .mockImplementationOnce(async function (
          this: LocalStorageAdapter,
          ...args
        ) {
          await originalPut.apply(this, args);
          throw Error('Synthetic lost storage acknowledgement');
        });
      try {
        await expect(broker(task, { url })).rejects.toThrow(
          'Synthetic lost storage acknowledgement',
        );
        const requests = source.fetch.mock.calls.length;
        source.move();
        const result = await broker(task, { url });
        expect(result.status).toBe('installed');
        expect(result.skill.source.commitSha).toBe(source.commit);
        expect(
          source.fetch.mock.calls
            .slice(requests)
            .every(([url]) => !String(url).includes('/commits/main')),
        ).toBe(true);
        const [count] =
          await f.db`select count(*)::int n from allrice_personal_skill_imports where instance_id=${x.custom.id}`;
        expect(count!.n).toBe(1);
        await task.finish();
      } finally {
        put.mockRestore();
        source.fetch.mockRestore();
      }
    });
    it.each([
      '先评估这个链接，不要安装：https://github.com/acme/skills',
      '请翻译“安装 https://github.com/acme/skills 里的技能”。',
      '本次临时用 https://github.com/acme/skills 的模板，不要长期保存。',
    ])(
      'rejects a non-install user request before any public network read: %s',
      async (text) => {
        const x = await setup(),
          task = await x.run(x.custom.id, text);
        const source = publicGitHub();
        try {
          await expect(
            broker(task, { url: 'https://github.com/acme/skills' }),
          ).rejects.toThrow();
          expect(source.fetch).not.toHaveBeenCalled();
          expect(await listPersonalSkills(x.context)).toEqual([]);
          await task.finish();
        } finally {
          source.fetch.mockRestore();
        }
      },
    );
    it('does not borrow attachment installation authority for a separate GitHub link', async () => {
      const x = await setup(),
        url = 'https://github.com/acme/skills';
      const task = await x.run(
        x.custom.id,
        `请安装我上传的 SKILL.md。\n${url}`,
        raw(),
      );
      const source = publicGitHub();
      try {
        await expect(broker(task, { url })).rejects.toThrow();
        expect(source.fetch).not.toHaveBeenCalled();
        expect(await listPersonalSkills(x.context)).toEqual([]);
        const [imports] =
          await f.db`select count(*)::int n from allrice_personal_skill_imports where instance_id=${x.custom.id}`;
        expect(imports!.n).toBe(0);
        await task.finish();
      } finally {
        source.fetch.mockRestore();
      }
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
      expect(await preparePersonalSkillImport(task.input)).toMatchObject({
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
        const item = PersonalSkillItemSchema.parse(
          await installPersonalSkillFromChat(task.input, parsed),
        );
        const retry = { ...task.input, callId: randomUUID() };
        expect(
          PersonalSkillItemSchema.parse(
            await installPersonalSkillFromChat(retry, parsed),
          ).id,
        ).toBe(item.id);
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
