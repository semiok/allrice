import { randomUUID } from 'node:crypto';
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
    async function setup() {
      const source = await createEmployeeAdministrationFixture(f.db);
      await savePlatformEmployeeDraft(source.employeeId, {
        definition: {
          ...source.definition,
          capabilities: {
            ...source.definition.capabilities,
            toolNames: ['workspace.skill.read', 'workspace.export.create'],
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
        raw?: string,
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
          objectId = randomUUID();
          const pending = await createStorageMetadata(context, {
            id: objectId,
            workspaceId: source.workspaceId,
            category: 'uploads',
            mediaType: 'text/markdown',
            sizeBytes: Buffer.byteLength(raw),
            checksum: skillBytesChecksum(raw),
            visibility: 'private',
            retentionUntil: null,
            immutable: false,
          });
          await assistantFixtureStorage(f.db).put(
            pending.object,
            new Blob([raw]).stream(),
          );
          await markStorageReady(context, objectId);
          await linkFileToSession({
            context,
            workspaceId: source.workspaceId,
            sessionId: session.id,
            objectId,
            fileName: 'SKILL.md',
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
