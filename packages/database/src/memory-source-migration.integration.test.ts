import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import * as client from './core/client.ts';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { createExperienceFixture } from './experience.fixture.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
suite('0240 empty memory source storage over existing legacy data', () => {
  it('leaves every legacy row and marker intact without copying data or enabling collection', async () => {
    const f = await createRuntimeFixtureDatabase({
      ownSchemaOnly: true,
      throughMigration: '0239_workbench_file_favorites.sql',
    });
    const mock = vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
    try {
      const legacy = await createExperienceFixture(f.db);
      const id = randomUUID(),
        digest = 'sha256:' + 'b'.repeat(64);
      const [identity] =
        await f.db`select er.employee_assignment_id instance_id,a.employee_id from allrice_employee_runs er join allrice_employee_assignments a on a.id=er.employee_assignment_id where er.run_id=${legacy.run}`;
      await f.db`insert into allrice_memories(id,organization_id,workspace_id,owner_id,employee_id,instance_id,content,visibility,source_type,source_id,lifecycle_state,memory_class,revision,trust_level,confidence)
        values(${id},${legacy.org},${legacy.workspace},${legacy.user},${identity!.employee_id},${identity!.instance_id},'synthetic legacy raw source','private','message',${legacy.message},'candidate','work_note',1,'derived',0.5)`;
      await f.db`insert into allrice_memory_revisions(organization_id,workspace_id,memory_id,revision,content,trust_level,lifecycle_state,memory_class,confidence,reason,changed_by)
        values(${legacy.org},${legacy.workspace},${id},1,'synthetic legacy raw source','derived','candidate','work_note',0.5,'synthetic legacy evidence',${legacy.user})`;
      await f.db`insert into allrice_experience_reviews(memory_id,organization_id,workspace_id,owner_id,client_request_id,request_digest,run_id,session_id,message_id,source_excerpt,source_digest,proposed_digest,requested_scope,share_acknowledged,origin_kind,instance_id,source_key,evidence)
        values(${id},${legacy.org},${legacy.workspace},${legacy.user},${randomUUID()},${digest},${legacy.run},${legacy.session.id},${legacy.message},'synthetic legacy raw source',${digest},${digest},'private',false,'incremental',${identity!.instance_id},${digest},'{}')`;
      await f.db`update allrice_employee_runs set experience_capture_state='pending',experience_capture_reason='memory_source_v2' where run_id=${legacy.run}`;
      await f.db`insert into allrice_settings(scope_type,scope_id,key,value) values('organization',${legacy.org},'employee_experience_policy','{"schemaVersion":1,"enabled":true}')`;
      const readLegacy = async () => ({
        memories: await f.db`select * from allrice_memories where id=${id}`,
        revisions:
          await f.db`select * from allrice_memory_revisions where memory_id=${id}`,
        reviews:
          await f.db`select * from allrice_experience_reviews where memory_id=${id}`,
        policy:
          await f.db`select * from allrice_settings where scope_id=${legacy.org} and key='employee_experience_policy'`,
        markers:
          await f.db`select experience_capture_state,experience_capture_reason,experience_captured_at,experience_execution_run_id from allrice_employee_runs where run_id=${legacy.run}`,
      });
      const before = await readLegacy();
      await f.db.begin(async (tx) => {
        await tx.unsafe(
          await readFile(
            new URL(
              '../migrations/0240_memory_source_storage.sql',
              import.meta.url,
            ),
            'utf8',
          ),
        );
      });
      expect(await readLegacy()).toEqual(before);
      expect(await f.db`select id from allrice_memory_sources`).toEqual([]);
      expect(
        await f.db`select value from allrice_settings where key='employee_memory_source_policy'`,
      ).toEqual([]);
      expect(
        await f.db`select memory_source_capture_state,memory_source_capture_reason,memory_source_captured_at,memory_source_execution_run_id from allrice_employee_runs`,
      ).toEqual([
        {
          memory_source_capture_state: null,
          memory_source_capture_reason: null,
          memory_source_captured_at: null,
          memory_source_execution_run_id: null,
        },
      ]);
    } finally {
      mock.mockRestore();
      await f.close();
    }
  }, 120000);
});
