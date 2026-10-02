import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TaskNextStepsInput } from '@allrice/contracts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { tenantValidationFixture } from './tenant-validation.fixture.ts';
import { readTaskNextSteps } from './task-next-steps.ts';
import {
  employeeManifest,
  employeeManifestChecksum,
} from './employees/employee-config.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'MET168 next-turn suggestions (isolated PostgreSQL ordinary member)',
  () => {
    let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      f = await createAssistantFixtureDatabase();
    }, 60000);
    afterAll(async () => {
      await f?.close();
      vi.unstubAllEnvs();
    });
    async function fixture() {
      const a = await tenantValidationFixture(f.db);
      const [assignment] = await f.db<
        { id: string; employee_id: string; employee_version_id: string }[]
      >`select id,employee_id,employee_version_id from allrice_employee_assignments where user_id=${a.context.actor.id}`;
      const [source] = await f.db<
        { object_id: string }[]
      >`select object_id from allrice_deliverable_versions where id=${a.artifact.artifactId}`;
      await f.db`insert into allrice_file_references(organization_id,workspace_id,owner_id,session_id,object_id,file_name) values(${a.context.organizationId},${a.context.workspaceId!},${a.context.actor.id},${a.task.chatSessionId},${source!.object_id},'evidence.txt')`;
      await f.db`update allrice_runs set state='succeeded',completed_at=clock_timestamp() where id=${a.task.runId}`;
      const input: TaskNextStepsInput = {
        sessionId: a.task.chatSessionId!,
        workspaceId: a.context.workspaceId!,
        employeeAssignmentId: assignment!.id,
        employeeVersionId: assignment!.employee_version_id,
      };
      return { a, input, assignment: assignment!, objectId: source!.object_id };
    }
    it('reads actual ready provenance for an ordinary member without changing Run, Session, references or audit', async () => {
      const { a, input, objectId } = await fixture();
      const before =
        await f.db`select employee_version_id,updated_at from allrice_chat_sessions where id=${input.sessionId}`;
      const counts = async () =>
        (
          await f.db`select (select count(*) from allrice_runs) as runs,(select count(*) from allrice_file_references) as refs,(select count(*) from allrice_audit_events) as audits`
        )[0];
      const originalCounts = await counts();
      const result = await readTaskNextSteps(a.context, input, f.db);
      expect(result.state).toBe('succeeded');
      expect(result.scope).toMatchObject({
        ...input,
        organizationId: a.context.organizationId,
        viewerId: a.context.actor.id,
        sourceRunId: a.task.runId,
      });
      expect(result.suggestions[0]?.task.title).toBe('提炼重点与待办');
      expect(result.suggestions[0]?.references[0]).toMatchObject({
        objectId,
        versionId: a.artifact.artifactId,
        checksum: a.artifact.digest,
      });
      expect(result).toEqual(await readTaskNextSteps(a.context, input, f.db));
      expect(JSON.stringify(result)).not.toMatch(
        /PRIVATE_TEST_SECRET|NEVER_EXPOSE_RAW|Authorization|toolNames|credentialReference|securityPolicy/,
      );
      expect(await counts()).toEqual(originalCounts);
      expect(
        await f.db`select employee_version_id,updated_at from allrice_chat_sessions where id=${input.sessionId}`,
      ).toEqual(before);
      expect(
        (
          await f.db`select role from allrice_memberships where user_id=${a.context.actor.id}`
        )[0]?.role,
      ).toBe('member');
    });
    it('rejects another member, tenant/workspace, Session assignment and outdated next-turn version', async () => {
      const { a, input } = await fixture(),
        foreign = await fixture();
      for (const bad of [
        { context: foreign.a.context, input },
        {
          context: a.context,
          input: { ...input, sessionId: foreign.input.sessionId },
        },
        {
          context: a.context,
          input: { ...input, workspaceId: foreign.input.workspaceId },
        },
        {
          context: a.context,
          input: {
            ...input,
            employeeAssignmentId: foreign.input.employeeAssignmentId,
          },
        },
        {
          context: a.context,
          input: { ...input, employeeVersionId: randomUUID() },
        },
      ])
        await expect(
          readTaskNextSteps(bad.context, bad.input, f.db),
        ).rejects.toThrow(/not_found|authorization_denied/);
      await f.db`update allrice_memberships set active=false where user_id=${a.context.actor.id}`;
      await expect(readTaskNextSteps(a.context, input, f.db)).rejects.toThrow(
        'not_found',
      );
    });
    it('uses the version the next message would send, preserving an existing pinned Session and old Run', async () => {
      const { a, input, assignment } = await fixture();
      const nextId = randomUUID();
      const next = employeeManifest({
        key: 'p25-fixture',
        name: 'Office',
        description: 'Synthetic version with read revoked',
        toolNames: [],
      });
      await f.db`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot) values(${nextId},${a.context.organizationId},${input.workspaceId},${assignment.employee_id},2,'Office',${next.provider.model},${next.systemPrompt},${f.db.json(next.capabilities)},${employeeManifestChecksum(next)},${f.db.json(next)},${f.db.json(next.provider)})`;
      await f.db`update allrice_employee_assignments set employee_version_id=${nextId} where id=${assignment.id}`;
      await expect(readTaskNextSteps(a.context, input, f.db)).rejects.toThrow(
        'not_found',
      );
      const result = await readTaskNextSteps(
        a.context,
        { ...input, employeeVersionId: nextId },
        f.db,
      );
      expect(result.scope.employeeVersionId).toBe(nextId);
      expect(result.suggestions).toEqual([]);
      expect(
        (
          await f.db`select employee_version_id from allrice_chat_sessions where id=${input.sessionId}`
        )[0]?.employee_version_id,
      ).toBe(input.employeeVersionId);
      expect(
        (
          await f.db`select employee_version_id from allrice_employee_runs where run_id=${a.task.runId}`
        )[0]?.employee_version_id,
      ).toBe(input.employeeVersionId);
    });
    it('ignores filenames, unfinished storage and previous rounds; respects deleted references and unknown physical operations', async () => {
      const { a, input, objectId } = await fixture();
      await f.db`update allrice_runtime_operations set snapshot=jsonb_set(snapshot,'{status}','"unknown"') where id=${a.operation}`;
      const unknown = await readTaskNextSteps(a.context, input, f.db);
      expect(unknown.state).toBe('unknown');
      expect(unknown.suggestions).toEqual([]);
      await f.db`update allrice_runtime_operations set snapshot=jsonb_set(snapshot,'{status}','"succeeded"') where id=${a.operation}`;
      await f.db`update allrice_runs set state='canceled' where id=${a.task.runId}`;
      expect(
        (await readTaskNextSteps(a.context, input, f.db)).notice,
      ).toContain('已取消');
      await f.db`delete from allrice_file_references where object_id=${objectId}`;
      expect(
        (await readTaskNextSteps(a.context, input, f.db)).suggestions,
      ).toEqual([]);
      const pendingId = randomUUID();
      const key = `organizations/${a.context.organizationId}/workspaces/${input.workspaceId}/owners/${a.context.actor.id}/exports/${pendingId}`;
      await f.db`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,state,immutable) values(${pendingId},${a.context.organizationId},${input.workspaceId},${a.context.actor.id},${key},'exports','application/pdf',10,${`sha256:${'a'.repeat(64)}`},'pending',true)`;
      await f.db`insert into allrice_file_references(organization_id,workspace_id,owner_id,session_id,object_id,file_name) values(${a.context.organizationId},${input.workspaceId},${a.context.actor.id},${input.sessionId},${pendingId},'任务已成功.pdf')`;
      expect(
        (await readTaskNextSteps(a.context, input, f.db)).readableArtifactCount,
      ).toBe(0);
    });
    it('does not recommend old ready artifacts once a newer formal Run has no delivery', async () => {
      const { a, input, assignment } = await fixture(),
        newRun = randomUUID(),
        userMessage = randomUUID(),
        assistantMessage = randomUUID();
      await f.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input,created_at) values(${newRun},${a.context.organizationId},${input.workspaceId},${a.context.actor.id},'succeeded','{}','{}',clock_timestamp()+interval '1 second')`;
      await f.db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content) values(${userMessage},${a.context.organizationId},${input.workspaceId},${input.sessionId},${a.context.actor.id},'user','{"text":"Synthetic new round"}'),(${assistantMessage},${a.context.organizationId},${input.workspaceId},${input.sessionId},${a.context.actor.id},'assistant','{"text":"Synthetic answer without delivery"}')`;
      await f.db`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot) values(${newRun},${a.context.organizationId},${input.workspaceId},${a.context.actor.id},${assignment.id},${input.employeeVersionId},${input.sessionId},${userMessage},${assistantMessage},'{}','{}')`;
      const result = await readTaskNextSteps(a.context, input, f.db);
      expect(result.scope.sourceRunId).toBe(newRun);
      expect(result.readableArtifactCount).toBe(0);
      expect(result.suggestions).toEqual([]);
      expect(
        await f.db`select id from allrice_deliverable_versions where id=${a.artifact.artifactId}`,
      ).toHaveLength(1);
    });
  },
);
