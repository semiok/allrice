import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createExperienceFixture } from './experience.fixture.ts';
import { sendChatMessage } from './workspace/service.ts';
import { employeeManifestChecksum } from './employees/employee-config.ts';
import { EmployeeManifestSchema } from '@allrice/contracts';

let isolated: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => isolated.db,
}));
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const input = (allowAssistants?: boolean) => ({
  clientMessageId: randomUUID(),
  text: 'Compare the supplied synthetic facts.',
  deliveryMode: 'follow_up',
  ...(allowAssistants === undefined
    ? {}
    : { assistantPreference: { mode: 'daily', allowAssistants } }),
});
async function grantFixtureAssistant(
  f: Awaited<ReturnType<typeof createExperienceFixture>>,
) {
  const db = isolated.db;
  const [row] =
    await db`select v.* from allrice_employee_versions v join allrice_employee_assignments a on a.employee_version_id=v.id where a.id=${f.session.employeeAssignmentId}`;
  const manifest = EmployeeManifestSchema.parse(row!.manifest);
  if (manifest.schemaVersion !== 2)
    throw Error('Expected current synthetic employee schema');
  manifest.capabilityBindings.toolNames.push('assistant.delegate');
  const versionId = randomUUID();
  await db`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest)
    select ${versionId},organization_id,workspace_id,employee_id,version+1,name,model,system_prompt,capabilities,${employeeManifestChecksum(manifest)},${db.json(manifest)} from allrice_employee_versions where id=${row!.id}`;
  await db`update allrice_employee_assignments set employee_version_id=${versionId} where id=${f.session.employeeAssignmentId}`;
  return versionId;
}

suite(
  'P26 real database queued preference, identity and immutable Run input',
  () => {
    beforeAll(async () => {
      isolated = await createAssistantFixtureDatabase();
    }, 120000);
    afterAll(async () => {
      vi.unstubAllEnvs();
      await isolated?.close();
    });

    it('keeps old requests single-agent and rejects an ungranted preference', async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      const f = await createExperienceFixture(isolated.db);
      const sent = await sendChatMessage(
        f.owner,
        f.workspace,
        f.session.id,
        input(),
      );
      const [row] =
        await isolated.db`select input from allrice_runs where id=${sent.run.id}`;
      expect(row!.input).not.toHaveProperty('assistantConfiguration');
      await expect(
        sendChatMessage(f.owner, f.workspace, f.session.id, input(true)),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('freezes explicit opt-out and keeps it stable across identical retries', async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      const f = await createExperienceFixture(isolated.db),
        body = input(false);
      const a = await sendChatMessage(f.owner, f.workspace, f.session.id, body);
      const b = await sendChatMessage(f.owner, f.workspace, f.session.id, body);
      expect(b.run.id).toBe(a.run.id);
      const [row] =
        await isolated.db`select input from allrice_runs where id=${a.run.id}`;
      expect(row!.input.assistantConfiguration).toMatchObject({
        version: 1,
        mode: 'daily',
        allowAssistants: false,
        maxConcurrent: 2,
        maxDepth: 1,
        maxChildren: 4,
      });
      await expect(
        sendChatMessage(f.owner, f.workspace, f.session.id, {
          ...body,
          assistantPreference: { mode: 'daily', allowAssistants: true },
        }),
      ).rejects.toMatchObject({ code: 'input_id_conflict' });
    });

    it('persists an explicit leading user restriction even when no UI preference was sent', async () => {
      const f = await createExperienceFixture(isolated.db);
      const sent = await sendChatMessage(f.owner, f.workspace, f.session.id, {
        ...input(),
        text: '本次不使用助手。请整理这份资料。',
      });
      const [row] =
        await isolated.db`select input from allrice_runs where id=${sent.run.id}`;
      expect(row!.input.assistantConfiguration.allowAssistants).toBe(false);
    });

    it('requires both enabled feature and explicit frozen employee grant; subsequent runs cannot modify earlier configuration', async () => {
      const f = await createExperienceFixture(isolated.db);
      const version = await grantFixtureAssistant(f);
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      await expect(
        sendChatMessage(f.owner, f.workspace, f.session.id, input(true)),
      ).rejects.toMatchObject({ code: 'forbidden' });
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      const first = await sendChatMessage(
        f.owner,
        f.workspace,
        f.session.id,
        input(true),
      );
      const second = await sendChatMessage(
        f.owner,
        f.workspace,
        f.session.id,
        input(false),
      );
      const [old] =
        await isolated.db`select r.input,e.execution_snapshot from allrice_runs r join allrice_employee_runs e on e.run_id=r.id where r.id=${first.run.id}`;
      const [next] =
        await isolated.db`select input from allrice_runs where id=${second.run.id}`;
      expect(old!.input.assistantConfiguration.allowAssistants).toBe(true);
      expect(old!.execution_snapshot.employee.versionId).toBe(version);
      expect(
        old!.execution_snapshot.capabilitySnapshot.bindings.toolNames,
      ).toContain('assistant.delegate');
      expect(next!.input.assistantConfiguration.allowAssistants).toBe(false);
    });

    it('cannot configure another owner or reuse a legacy request receipt with changed intent', async () => {
      const f = await createExperienceFixture(isolated.db),
        body = input();
      const sent = await sendChatMessage(
        f.owner,
        f.workspace,
        f.session.id,
        body,
      );
      await expect(
        sendChatMessage(f.neighbor, f.workspace, f.session.id, input(false)),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await isolated.db`delete from allrice_chat_input_requests where user_message_id=${sent.userMessage.id}`;
      await expect(
        sendChatMessage(f.owner, f.workspace, f.session.id, {
          ...body,
          assistantPreference: { mode: 'daily', allowAssistants: false },
        }),
      ).rejects.toMatchObject({ code: 'input_id_conflict' });
    });
  },
);
