import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAssistantFixtureDatabase } from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from '../../../../packages/database/src/assistant-authority.fixture.ts';
import { assertAssistantAuthority } from '../../../../packages/database/src/assistant-authority.ts';
import { productionAssistantController } from '../../src/harness/dsh/assistant-controller.js';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const sha = (text: string) =>
  `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
// MET-219, seen on Dev root d6bad738: the user stopped child A while its model
// stream was in flight. The aborted call keeps its whole output reservation
// (its usage is unknown), Rice then ends with an empty reply, and the checked
// delivery repair must still be allowed to write the final answer.
integration(
  'P25 checked delivery repair after a stopped child (production controller + PostgreSQL)',
  () => {
    let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      database = await createAssistantFixtureDatabase();
    }, 120000);
    afterAll(async () => {
      await database?.close();
      vi.unstubAllEnvs();
    });
    it('a stopped child holding the whole output reservation leaves the repair allowed', async () => {
      const f = await createAssistantAuthorityFixture(database.db, {
        configure: false,
        memberRole: 'member',
        allowedTools: ['assistant.delegate', 'assistant.report'],
        snapshot: (value) => ({
          ...value,
          finalDeliveryPolicy: {
            version: 1,
            mode: 'checked_native_v1',
            artifactId: 'sha256:' + 'a'.repeat(64),
          },
        }),
      });
      // The production controller creates the frozen root and budgets itself.
      await database.db.begin(async (tx) => {
        await tx`delete from allrice_runtime_budgets where root_run_id=${f.task.runId}`;
        await tx`delete from allrice_runtime_run_links where root_run_id=${f.task.runId}`;
        await tx`delete from allrice_runtime_roots where root_run_id=${f.task.runId}`;
      });
      const outputBound = 5000;
      const controller = productionAssistantController({
        deliveryMode: 'checked_native_v1',
        deliveryArtifactId: 'sha256:' + 'a'.repeat(64),
        configuration: f.config,
        database: database.db,
        authorize: assertAssistantAuthority,
        worker: f.worker,
        tools: [{ name: 'assistant.delegate' }, { name: 'assistant.report' }],
        runLimits: { maxOutputTokens: outputBound },
        context: {
          executionId: randomUUID(),
          runId: f.task.runId,
          jobId: f.worker.jobId,
          worker: { type: 'worker', id: f.worker.workerId },
          delegatedBy: { type: 'user', id: f.user },
          organizationId: f.org,
          workspaceId: f.workspace,
          startedAt: new Date().toISOString(),
          policySnapshot: {
            id: f.policy,
            organizationId: f.org,
            subjectId: f.user,
            version: 1,
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
            memberships: f.context.memberships,
            grants: [
              {
                resourceType: 'job',
                action: 'job:execute',
                workspaceId: f.workspace,
              },
            ],
          },
        },
      })!;
      const rootSession = `dsh-${f.session}`;
      const tree = () => f.runtime.getTree(f.context, { runId: f.task.runId });
      const bound = await controller.bind(rootSession, f.worker.generation);
      // "请用两个子助理并行做：A 写一篇 5000 字的小说……" — Rice delegates A.
      const delegated = await bound.handle('delegate', {
        nativeSessionId: rootSession,
        callId: randomUUID(),
        arguments: {
          label: 'A',
          text: '写一篇 5000 字、分 10 章的短篇小说《南山的茶》',
          tools: ['assistant.report'],
        },
      });
      const child = (await tree()).instances.find(
        (i) => i.parentRunId !== null,
      )!;
      expect(delegated).toMatchObject({ dispatch: expect.anything() });
      // A starts writing: its model call is dispatched with the full bound.
      const callId = randomUUID();
      await bound.handle('model-prepare', {
        nativeSessionId: child.nativeSessionId,
        callId,
        outputTokens: outputBound,
      });
      await bound.handle('model-dispatch', {
        nativeSessionId: child.nativeSessionId,
        callId,
        inputTokens: 900,
        outputTokens: outputBound,
        requestDigest: sha('chapter one'),
      });
      // The user presses "停止这个助手". The drained stream settles the call
      // without token counts, then native confirms the stop.
      await f.runtime.cancelChild(f.context, {
        runId: f.task.runId,
        childRunId: child.runId,
        requestId: randomUUID(),
      });
      await bound.handle('model-settle', {
        nativeSessionId: child.nativeSessionId,
        callId,
      });
      await bound.handle('stopped', { nativeSessionId: child.nativeSessionId });
      const before = (await tree()).budgets;
      const output = before.find((b) => b.metric === 'output_tokens')!;
      expect(output).toMatchObject({ capacity: outputBound, enforced: false });
      expect(output.reserved + output.spent).toBeGreaterThanOrEqual(
        output.capacity,
      );
      const heldBefore =
        await database.db`select * from allrice_assistant_usage where call_id=${callId} order by metric`;
      // Rice's last reply is empty, so native asks to repair the delivery.
      const [provider] = await database.db<
        { route: string; model: string }[]
      >`select provider_snapshot->>'route' route,provider_snapshot->>'model' model from allrice_employee_runs where run_id=${f.task.runId}`;
      const text = '';
      const request = {
        phase: 'propose',
        candidate: {
          nativeSessionId: rootSession,
          turn: 1,
          publicMessageId: randomUUID(),
          durableSeq: 28,
          text,
          candidateDigest: sha(text),
          provider: provider!.route,
          model: provider!.model,
        },
      };
      const authority = await bound.deliveryRepair!.authorize(request);
      expect(authority).toMatchObject({
        allowed: true,
        runId: f.task.runId,
        remainingModelCalls: expect.any(Number),
        remainingOutputTokens: outputBound,
      });
      expect(authority.remainingModelCalls).toBeGreaterThanOrEqual(1);
      for (const phase of ['prepared', 'consume', 'dispatch'])
        await expect(
          bound.deliveryRepair!.authorize({ ...request, phase }),
        ).resolves.toEqual(authority);
      // Nothing was released or invented: A's tokens stay unknown and reserved.
      const after = (await tree()).budgets;
      expect(after).toEqual(before);
      expect(
        await database.db`select * from allrice_assistant_usage where call_id=${callId} order by metric`,
      ).toEqual(heldBefore);
      const held = await database.db<
        { metric: string; amount: string; settled_amount: string | null }[]
      >`select metric,amount,settled_amount from allrice_assistant_usage where call_id=${callId} order by metric`;
      expect(
        Object.fromEntries(held.map((h) => [h.metric, h.settled_amount])),
      ).toEqual({
        input_tokens: null,
        model_calls: '1',
        output_tokens: null,
        tool_calls: '0',
      });
      expect(
        Number(held.find((h) => h.metric === 'output_tokens')!.amount),
      ).toBe(outputBound);
    }, 60000);
  },
);
