import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createP27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { createChatSession } from '../../../packages/database/src/workspace/service.ts';
import {
  createOnceTask,
  initializeNativeOncePartition,
  listOnceTasks,
} from '../../../packages/database/src/native-schedule-once-product.ts';
import { measureDshNativeArtifact } from './harness/dsh-native-artifact.ts';
import { createNativeOnceControlSource } from './native-schedule-once-loader.ts';
import { createNativeOnceWorkerRuntime } from './native-schedule-once-runtime.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

/** Real local public Schedule + production SQL/consumer, no model or tool
 * execution. The explicit registry seam is fixture approval, not Dev approval. */
suite(
  'native once real Host and isolated PostgreSQL',
  { timeout: 120_000 },
  () => {
    let fixture: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
    let stateRoot: string;
    let source: ReturnType<typeof createNativeOnceControlSource>;
    const runtimes: ReturnType<typeof createNativeOnceWorkerRuntime>[] = [];
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      vi.stubEnv('ALLRICE_NATIVE_ONCE_ENABLED', '1');
      fixture = await createP27CodexWorkerFixture({
        allowCiDatabase: true,
        personalProfile: 'writable',
      });
      stateRoot = await realpath(
        await mkdtemp(join(tmpdir(), 'allrice-once-host-sql-')),
      );
      const root = await realpath(
        fileURLToPath(new URL('../../../', import.meta.url)),
      );
      const measured = await measureDshNativeArtifact(root);
      const reference = {
        artifactId: measured.artifactId,
        profileId: 'allrice-once-control-v1',
        storageId: 'isolated-real-host-sql',
        stateRoot,
      };
      vi.stubEnv('ALLRICE_NATIVE_ONCE_REFERENCE', JSON.stringify(reference));
      source = createNativeOnceControlSource(reference, {
        approvedArtifact: () => ({
          artifactId: measured.artifactId,
          generation: measured.content.generation,
          root,
          content: measured.content,
        }),
      });
      await initializeNativeOncePartition(reference);
    }, 120_000);
    afterAll(async () => {
      try {
        for (const runtime of runtimes) await runtime.stop();
      } finally {
        try {
          await fixture?.close();
        } finally {
          if (stateRoot) await rm(stateRoot, { recursive: true, force: true });
          vi.unstubAllEnvs();
        }
      }
    }, 30_000);
    const runtime = () => {
      const value = createNativeOnceWorkerRuntime({
        enabled: true,
        workerId: randomUUID(),
        reference: source.reference,
        loadModules: () => source.loadModules(),
        loadHostFactory: () => source.loadHostFactory(),
      });
      runtimes.push(value);
      return value;
    };
    it('cold resumes the same persisted control then dispatches one ordinary Run from a real native timer', async () => {
      const chat = await createChatSession(fixture.context, {
        workspaceId: fixture.workspaceId,
        employeeAssignmentId: fixture.assignmentId,
        title: 'Real native timer, no model',
      });
      const input = {
        clientRequestId: randomUUID(),
        name: '真实计时器',
        prompt: '回复唯一校验词 NATIVE-ONCE-SQL。',
        runAt: new Date(Date.now() + 25_000).toISOString(),
        timezone: 'Asia/Shanghai',
      };
      const created = await createOnceTask(fixture.context, chat.id, input);
      const first = runtime();
      await first.tick();
      const [before] =
        await fixture.db`select control_session_id,native_task_id,snapshot from allrice_native_once_controls where automation_id=${created.id}`;
      expect(before?.native_task_id, JSON.stringify(first.status())).toEqual(
        expect.any(String),
      );
      expect(before?.snapshot.control.sessionState).toBe('ready');
      expect(
        await fixture.db`select run_id from allrice_automation_runs where automation_id=${created.id}`,
      ).toHaveLength(0);
      await first.stop();
      const [closed] =
        await fixture.db`select epoch,closed,close_proof from allrice_native_once_partitions`;
      expect(closed?.closed).toBe(true);
      expect(closed?.close_proof).not.toBeNull();
      const second = runtime();
      await second.tick();
      const [resumed] =
        await fixture.db`select control_session_id,native_task_id from allrice_native_once_controls where automation_id=${created.id}`;
      expect(resumed).toMatchObject({
        control_session_id: before!.control_session_id,
        native_task_id: before!.native_task_id,
      });
      const deadline = Date.parse(input.runAt) + 12_000;
      let result = (
        await listOnceTasks(fixture.context, chat.id, {
          clientRequestId: input.clientRequestId,
        })
      ).tasks[0]!;
      while (!result.runId && Date.now() < deadline) {
        await second.tick();
        await new Promise((resolve) => setTimeout(resolve, 200));
        result = (
          await listOnceTasks(fixture.context, chat.id, {
            clientRequestId: input.clientRequestId,
          })
        ).tasks[0]!;
      }
      expect(
        result.status,
        JSON.stringify({ result, runtime: second.status() }),
      ).toBe('queued');
      expect(result.runId).toEqual(expect.any(String));
      const rows =
        await fixture.db`select o.outbox_state,o.business_binding,er.user_message_id,j.status,m.content->>'text' text
      from allrice_native_once_occurrences o join allrice_automation_runs ar on ar.native_once_occurrence_id=o.occurrence_id
      join allrice_employee_runs er on er.run_id=ar.run_id join allrice_jobs j on j.run_id=er.run_id
      join allrice_messages m on m.id=er.user_message_id where o.automation_id=${created.id}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        outbox_state: 'enqueued',
        status: 'queued',
        text: input.prompt,
      });
      expect(rows[0]!.business_binding.runId).toBe(result.runId);
      await second.tick();
      await second.tick();
      expect(
        (await createOnceTask(fixture.context, chat.id, input)).runId,
      ).toBe(result.runId);
      expect(
        await fixture.db`select id from allrice_jobs where run_id=${result.runId}`,
      ).toHaveLength(1);
      expect(second.status().controller?.stats.adapterCalls).toBe(0);
      await second.stop();
      const [final] =
        await fixture.db`select epoch,closed,close_proof from allrice_native_once_partitions`;
      expect(Number(final!.epoch)).toBe(Number(closed!.epoch) + 1);
      expect(final!.closed).toBe(true);
      expect(final!.close_proof).not.toEqual(closed!.close_proof);
    });
  },
);
