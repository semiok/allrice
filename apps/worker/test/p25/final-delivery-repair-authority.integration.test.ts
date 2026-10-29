import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRuntimeFixtureDatabase } from '../../../../packages/database/src/runtime.fixture.ts';
import { createRunAuthorityFixture } from '../../../../packages/database/src/run-authority.fixture.ts';
import { assertAssistantAuthority } from '../../../../packages/database/src/assistant-authority.ts';
import { productionAssistantController } from '../../src/harness/dsh/assistant-controller.js';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const sha = (text: string) =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;
const artifactId = 'sha256:' + 'a'.repeat(64);
const outputBound = 5000;

integration(
  'MET-219 observed repair budget with current PostgreSQL authority',
  () => {
    let database: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      database = await createRuntimeFixtureDatabase();
    }, 120000);
    afterAll(async () => {
      await database?.close();
      vi.unstubAllEnvs();
    });

    async function fixture() {
      const f = await createRunAuthorityFixture(database.db, {
        configure: false,
        memberRole: 'member',
        allowedTools: ['assistant.delegate', 'assistant.report'],
        snapshot: (value) => ({
          ...value,
          finalDeliveryPolicy: {
            version: 1,
            mode: 'checked_native_v1',
            artifactId,
          },
        }),
      });
      await database.db.begin(async (tx) => {
        await tx`delete from allrice_runtime_budgets where root_run_id=${f.task.runId}`;
        await tx`delete from allrice_runtime_run_links where root_run_id=${f.task.runId}`;
        await tx`delete from allrice_runtime_roots where root_run_id=${f.task.runId}`;
      });
      const controller = productionAssistantController({
        deliveryMode: 'checked_native_v1',
        deliveryArtifactId: artifactId,
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
      const nativeSessionId = `dsh-${f.session}`;
      const bound = await controller.bind(nativeSessionId, f.worker.generation);
      const [provider] = await database.db<{ route: string; model: string }[]>`
      select provider_snapshot->>'route' route,provider_snapshot->>'model' model
      from allrice_employee_runs where run_id=${f.task.runId}`;
      const request = {
        phase: 'propose',
        candidate: {
          nativeSessionId,
          turn: 1,
          publicMessageId: randomUUID(),
          durableSeq: 28,
          text: '',
          candidateDigest: sha(''),
          provider: provider!.route,
          model: provider!.model,
        },
      };
      const tree = () => f.runtime.getTree(f.context, { runId: f.task.runId });
      const ledger = async () => ({
        budgets:
          await database.db`select * from allrice_runtime_budgets where root_run_id=${f.task.runId} order by metric`,
        usage:
          await database.db`select * from allrice_assistant_usage where root_run_id=${f.task.runId} order by call_id,metric`,
      });
      const completeOutput = async () => {
        const callId = randomUUID();
        await bound.handle('model-prepare', {
          nativeSessionId,
          callId,
          outputTokens: outputBound,
        });
        await bound.handle('model-dispatch', {
          nativeSessionId,
          callId,
          inputTokens: 100,
          outputTokens: outputBound,
          requestDigest: sha(callId),
        });
        await bound.handle('model-settle', {
          nativeSessionId,
          callId,
          inputTokens: 100,
          outputTokens: 4000,
        });
      };
      return { f, bound, request, tree, ledger, completeOutput };
    }

    it('repairs an empty reply after completed outputs exceed one response capacity, without stopping any assistant', async () => {
      // User: "先写两部分长篇内容，再把结果汇总给我。" Both model calls finish.
      const h = await fixture();
      await h.completeOutput();
      await h.completeOutput();
      const tree = await h.tree();
      expect(tree.instances).toHaveLength(1);
      expect(tree.instances[0]).toMatchObject({
        parentRunId: null,
        stoppedAt: null,
      });
      expect(
        tree.budgets.find((b) => b.metric === 'output_tokens'),
      ).toMatchObject({
        capacity: outputBound,
        reserved: 0,
        spent: 8000,
        enforced: false,
      });
      const before = await h.ledger();
      for (const phase of ['propose', 'prepared', 'consume', 'dispatch'])
        await expect(
          h.bound.deliveryRepair!.authorize({ ...h.request, phase }),
        ).resolves.toMatchObject({
          allowed: true,
          remainingModelCalls: tree.budgets.find(
            (b) => b.metric === 'model_calls',
          )!.capacity,
          remainingOutputTokens: outputBound,
        });
      expect(await h.ledger()).toEqual(before);
    });

    it.each([
      'deadline',
      'root canceled',
      'membership revoked',
      'lease expired',
      'lease replaced',
    ] as const)(
      'refuses %s after an observed-budget repair was authorized',
      async (loss) => {
        const h = await fixture();
        await h.completeOutput();
        await h.completeOutput();
        const first = await h.bound.deliveryRepair!.authorize(h.request);
        expect(first).toMatchObject({
          allowed: true,
          remainingOutputTokens: outputBound,
        });
        let expected: string;
        let clock: ReturnType<typeof vi.spyOn> | undefined;
        if (loss === 'deadline') {
          clock = vi
            .spyOn(Date, 'now')
            .mockReturnValue(first.originalDeadlineAt);
          expected = 'FINAL_DELIVERY_REPAIR_DEADLINE';
        } else if (loss === 'root canceled') {
          await h.f.runtime.cancelRoot(h.f.context, {
            runId: h.f.task.runId,
            requestId: randomUUID(),
          });
          expected = 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE';
        } else if (loss === 'membership revoked') {
          await database.db`update allrice_memberships set active=false where id=${h.f.membership}`;
          expected = 'assistant_authority_denied';
        } else {
          if (loss === 'lease expired')
            await database.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${h.f.worker.jobId}`;
          else
            await database.db`update allrice_jobs set lease_token=${randomUUID()} where id=${h.f.worker.jobId}`;
          expected = 'lease_lost';
        }
        try {
          const before = await h.ledger();
          for (const phase of ['propose', 'prepared', 'consume', 'dispatch']) {
            const authorization = h.bound.deliveryRepair!.authorize({
              ...h.request,
              phase,
            });
            if (loss === 'root canceled')
              await expect(authorization).rejects.toMatchObject({
                code: expected,
              });
            else await expect(authorization).rejects.toThrow(expected);
          }
          expect(await h.ledger()).toEqual(before);
        } finally {
          clock?.mockRestore();
        }
      },
    );
  },
);
