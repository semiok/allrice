import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RouteDecisionSchema,
  resolveSubscriptionSnapshot,
} from '@allrice/contracts';
import { createP27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import {
  recordRouteDecision,
  completeRouteDecision,
} from './execution/route-decision.ts';
import { freezeRouteSubscriptionSnapshot } from './execution/route-subscription.ts';
import { createTaskProgressRuntime } from './task-progress.ts';
import { readTaskClock } from './task-clock.ts';
import { listDshRuntimeEventTimeline } from './conversation/conversation-runtime.ts';
import { cancelRun } from './execution/queue.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'MET-153 real Run binding, subscription proof and durable progress',
  () => {
    let f: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
    afterEach(async () => {
      await f?.close();
      vi.unstubAllEnvs();
    });
    async function setup(proof = true) {
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
      f = await createP27CodexWorkerFixture({ allowCiDatabase: true });
      const task = await f.prepareOrdinaryTask(
        'Synthetic MET153 task; never invoke a model.',
      );
      const frozen = task.binding.executionSnapshot.modelSnapshot!;
      // This is the actual prepareEmployeeRunBinding -> enqueue -> start path,
      // not a direct insert of a clock or a rewrite of the old model snapshot.
      expect(task.binding.executionSnapshot.runtimePolicy.timeoutMs).toBe(
        3600000,
      );
      const decision = RouteDecisionSchema.parse({
        schemaVersion: 1,
        id: randomUUID(),
        runId: task.runId,
        organizationId: f.organizationId,
        workspaceId: f.workspaceId,
        actorId: f.ownerId,
        employeeId: f.employeeId,
        inputChecksum: `sha256:${'a'.repeat(64)}`,
        candidates: [
          {
            id: 'direct:test',
            kind: 'direct',
            name: 'Test',
            bindingId: null,
            requiredCapabilities: [],
            risk: 'low',
            requiresApproval: false,
            authorized: true,
            exclusionReason: null,
            score: 1,
          },
        ],
        selectedKind: 'direct',
        selectedCandidateId: 'direct:test',
        harness: 'dsh',
        provider: 'openai-codex',
        model: frozen.model,
        modelConnectionId: f.connectionId,
        modelCatalogEntryId: f.catalogId,
        modelPolicyRevision: frozen.policyRevision,
        generation: 1,
        attempt: 1,
        reasonCodes: ['direct_no_capability_match'],
        createdAt: new Date().toISOString(),
      });
      await recordRouteDecision(decision, f.db);
      if (proof) {
        const snapshot = resolveSubscriptionSnapshot({
          sessionId: task.sessionId,
          modelSnapshot: frozen,
          decision,
          providerSnapshot: {
            provider: 'dsh',
            route: 'openai-codex',
            authMode: 'platform_subscription',
            model: frozen.model,
            credentialReference: frozen.credentialReference!,
            baseUrl: null,
            reasoningEffort: frozen.reasoningEffort,
          },
        })!;
        await freezeRouteSubscriptionSnapshot(
          {
            organizationId: f.organizationId,
            workspaceId: f.workspaceId,
            decisionId: decision.id,
            snapshot,
          },
          f.db,
        );
      }
      const worker = task.workflowLease,
        context = task.execution.context;
      const port = () => createTaskProgressRuntime({ context, worker }, f.db);
      const nativeSessionId = randomUUID();
      return { task, context, worker, port, nativeSessionId, decision };
    }
    it.each([true, false])(
      'ordinary model receipts preserve unknown usage across a retry (subscription proof=%s)',
      async (proof) => {
        const s = await setup(proof),
          handle = s.port();
        const firstCall = randomUUID();
        await handle({
          action: 'start',
          kind: 'model',
          nativeSessionId: s.nativeSessionId,
          callId: firstCall,
        });
        const receipt = {
          action: 'finish',
          kind: 'model',
          nativeSessionId: s.nativeSessionId,
          callId: firstCall,
          resultDigest: `sha256:${'a'.repeat(64)}`,
          outcome: 'error',
        };
        await handle(receipt);
        await handle(receipt);
        const outcome = {
          decisionId: s.decision.id,
          status: 'failed' as const,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          costCents: null,
          usageComplete: false,
          cacheUsageKnown: false,
          errorCode: 'SYNTHETIC_UNKNOWN_USAGE',
          completedAt: new Date().toISOString(),
        };
        const settle = (value = outcome) =>
          completeRouteDecision(
            {
              organizationId: f.organizationId,
              workspaceId: f.workspaceId,
              outcome: value,
            },
            f.db,
          );
        await settle();
        await settle();
        const before =
          await f.db`select * from allrice_model_usage_ledger where route_decision_id=${s.decision.id}`;
        expect(before).toHaveLength(1);
        expect(before[0]).toMatchObject({
          input_tokens: 0,
          output_tokens: 0,
          usage_complete: false,
          cache_usage_known: false,
          cost_cents: null,
        });
        // A new ordinary call can start; it must not repair the first call's
        // unknown accounting or make the old dispatch replayable.
        const retry = randomUUID();
        await handle({
          action: 'start',
          kind: 'model',
          nativeSessionId: s.nativeSessionId,
          callId: retry,
        });
        await handle({
          ...receipt,
          callId: retry,
          resultDigest: `sha256:${'b'.repeat(64)}`,
          outcome: 'success',
        });
        await expect(
          handle({
            action: 'start',
            kind: 'model',
            nativeSessionId: s.nativeSessionId,
            callId: firstCall,
          }),
        ).rejects.toThrow('task_progress_call_unknown_no_replay');
        await expect(
          settle({ ...outcome, usageComplete: true }),
        ).rejects.toThrow('route decision outcome conflict');
        expect(
          await f.db`select * from allrice_model_usage_ledger where route_decision_id=${s.decision.id}`,
        ).toEqual(before);
        const calls =
          await f.db`select finished_at,settled_output_tokens from allrice_task_calls where run_id=${s.task.runId} and kind='model'`;
        expect(calls).toHaveLength(2);
        expect(
          calls.every(
            (call) =>
              call.finished_at instanceof Date &&
              call.settled_output_tokens === null,
          ),
        ).toBe(true);
      },
    );
    it.each([true, false])(
      'crosses 16/64/80 and retains pause/recovery without usage gates (subscription proof=%s)',
      async (proof) => {
        const s = await setup(proof),
          handle = s.port();
        await handle({ action: 'check', nativeSessionId: s.nativeSessionId });
        const task = { runId: s.task.runId };
        for (let i = 0; i < 81; i++) {
          const callId = randomUUID();
          await handle({
            action: 'start',
            kind: 'model',
            nativeSessionId: s.nativeSessionId,
            callId,
          });
          await handle({
            action: 'finish',
            kind: 'model',
            nativeSessionId: s.nativeSessionId,
            callId,
            resultDigest: `sha256:${i.toString(16).padStart(64, '0')}`,
            outcome: 'success',
          });
          const toolId = randomUUID();
          await handle({
            action: 'start',
            kind: 'tool',
            nativeSessionId: s.nativeSessionId,
            callId: toolId,
            name: 'read',
            argumentsDigest: `sha256:${'1'.repeat(64)}`,
          });
          await handle({
            action: 'finish',
            kind: 'tool',
            nativeSessionId: s.nativeSessionId,
            callId: toolId,
            resultDigest: `sha256:${i.toString(16).padStart(64, '0')}`,
            outcome: 'success',
          });
        }
        expect(
          await f.db`select kind,count(*)::int calls,count(*) filter(where finished_at is null)::int pending from allrice_task_calls where run_id=${task.runId} group by kind order by kind`,
        ).toEqual([
          { kind: 'model', calls: 81, pending: 0 },
          { kind: 'tool', calls: 81, pending: 0 },
        ]);
        for (let i = 0; i < 3; i++) {
          await handle({
            action: 'start',
            kind: 'tool',
            nativeSessionId: s.nativeSessionId,
            callId: `error-${i}`,
            name: 'read',
            argumentsDigest: `sha256:${'a'.repeat(64)}`,
          });
          await handle({
            action: 'finish',
            kind: 'tool',
            nativeSessionId: s.nativeSessionId,
            callId: `error-${i}`,
            resultDigest: `sha256:${'b'.repeat(64)}`,
            outcome: 'error',
          });
        }
        const resumed = s.port(),
          paused = await resumed({
            action: 'check',
            nativeSessionId: s.nativeSessionId,
          });
        expect(paused).toMatchObject({
          paused: true,
          reason: 'repeated_failure',
        });
        expect(
          (await f.db.begin((tx) => readTaskClock(tx, task.runId)))!.phase,
        ).toBe('waiting');
        await expect(
          resumed({
            action: 'start',
            kind: 'model',
            nativeSessionId: s.nativeSessionId,
            callId: 'must-not-dispatch',
          }),
        ).rejects.toThrow('task_progress_paused');
        await expect(
          resumed({
            action: 'decide',
            nativeSessionId: s.nativeSessionId,
            pauseId: randomUUID(),
            decision: 'continue',
          }),
        ).rejects.toThrow('task_progress_stale_pause');
        await resumed({
          action: 'decide',
          nativeSessionId: s.nativeSessionId,
          pauseId: paused.pauseId,
          decision: 'continue',
        });
        expect(
          await resumed({
            action: 'check',
            nativeSessionId: s.nativeSessionId,
          }),
        ).toMatchObject({ paused: false });
        expect(
          (await f.db.begin((tx) => readTaskClock(tx, task.runId)))!.calls!
            .toolCalls,
        ).toBe(84);
        const timeline = await listDshRuntimeEventTimeline(s.task.sessionId, {
          database: f.db,
        });
        expect(
          timeline.turns.find((t) => t.run.id === task.runId)?.timing,
        ).toMatchObject({
          timeoutMs: 3600000,
          sources: [],
          calls: { toolCalls: 84, pending: 0 },
        });
        expect(
          (await listDshRuntimeEventTimeline(randomUUID(), { database: f.db }))
            .turns,
        ).toEqual([]);
        const wrongLease = createTaskProgressRuntime(
          {
            context: s.context,
            worker: { ...s.worker, leaseToken: randomUUID() },
          },
          f.db,
        );
        await expect(
          wrongLease({ action: 'check', nativeSessionId: s.nativeSessionId }),
        ).rejects.toThrow('task_progress_lease_lost');
      },
      60000,
    );
    it('preserves receipts, rejects cross-tenant and duplicate dispatch, and durably cancels without replay', async () => {
      const s = await setup(),
        handle = s.port();
      const crossTenant = createTaskProgressRuntime(
        {
          context: { ...s.context, organizationId: randomUUID() },
          worker: s.worker,
        },
        f.db,
      );
      await expect(
        crossTenant({ action: 'check', nativeSessionId: s.nativeSessionId }),
      ).rejects.toThrow('task_progress_lease_lost');
      let paused: Record<string, unknown> = {};
      for (let i = 0; i < 3; i++) {
        const start = {
          action: 'start',
          kind: 'tool',
          nativeSessionId: s.nativeSessionId,
          callId: `failed-${i}`,
          name: 'read',
          argumentsDigest: `sha256:${'a'.repeat(64)}`,
        };
        const receipt = {
          kind: start.kind,
          nativeSessionId: start.nativeSessionId,
          callId: start.callId,
          action: 'finish',
          resultDigest: `sha256:${'b'.repeat(64)}`,
          outcome: 'error',
        };
        await handle(start);
        await expect(handle(start)).rejects.toThrow(
          'task_progress_call_unknown_no_replay',
        );
        paused = await handle(receipt);
        await handle(receipt); // Idempotent receipt is not a second call.
        await expect(
          handle({ ...receipt, outcome: 'success' }),
        ).rejects.toThrow('task_progress_receipt_conflict');
      }
      expect(paused.paused).toBe(true);
      await s.port()({
        action: 'decide',
        nativeSessionId: s.nativeSessionId,
        pauseId: paused.pauseId,
        decision: 'cancel',
      });
      const [job] =
        await f.db`select cancel_requested_at from allrice_jobs where id=${s.worker.jobId}`;
      expect(job!.cancel_requested_at).toBeInstanceOf(Date);
      expect(
        await f.db`select 1 from allrice_task_calls where run_id=${s.task.runId}`,
      ).toHaveLength(3);
      expect(
        await f.db`select decision from allrice_task_progress_decisions where run_id=${s.task.runId}`,
      ).toMatchObject([{ decision: 'cancel' }]);
      await expect(
        s.port()({ action: 'check', nativeSessionId: s.nativeSessionId }),
      ).rejects.toThrow('task_progress_lease_lost');
    }, 30000);
    it.each([
      ['model', 'requested'],
      ['tool', 'requested'],
      ['model', 'progress'],
      ['tool', 'progress'],
    ] as const)(
      'accepts only existing late terminal receipts for %s after %s cancellation without changing progress decisions',
      async (kind, cancellation) => {
        const s = await setup(),
          handle = s.port();
        const argumentsDigest = `sha256:${'a'.repeat(64)}`;
        const resultDigest = `sha256:${'b'.repeat(64)}`;
        // A late third failed tool would ordinarily create a pause. Its actual
        // result must remain recordable after cancellation without that decision.
        for (let i = 0; i < 3; i++) {
          await handle({
            action: 'start',
            kind: 'tool',
            nativeSessionId: s.nativeSessionId,
            callId: `late-tool-${i}`,
            name: 'read',
            argumentsDigest,
          });
          if (i < 2)
            await handle({
              action: 'finish',
              kind: 'tool',
              nativeSessionId: s.nativeSessionId,
              callId: `late-tool-${i}`,
              resultDigest,
              outcome: 'error',
            });
        }
        await handle({
          action: 'start',
          kind: 'model',
          nativeSessionId: s.nativeSessionId,
          callId: 'late-model',
        });
        if (cancellation === 'progress') {
          await handle({
            action: 'start',
            kind: 'tool',
            nativeSessionId: s.nativeSessionId,
            callId: 'pause-trigger',
            name: 'read',
            argumentsDigest,
          });
          const pause = await handle({
            action: 'finish',
            kind: 'tool',
            nativeSessionId: s.nativeSessionId,
            callId: 'pause-trigger',
            resultDigest,
            outcome: 'error',
          });
          await handle({
            action: 'decide',
            nativeSessionId: s.nativeSessionId,
            pauseId: pause.pauseId,
            decision: 'cancel',
          });
        } else {
          await cancelRun(f.context, f.workspaceId, s.task.runId, {
            reason: 'user_requested',
          });
        }
        const [before] =
          await f.db`select * from allrice_task_progress where run_id=${s.task.runId}`;
        const receipt = {
          action: 'finish',
          nativeSessionId: s.nativeSessionId,
          callId: kind === 'model' ? 'late-model' : 'late-tool-2',
          kind,
          resultDigest,
          outcome: 'error',
        };
        await expect(handle(receipt)).resolves.toMatchObject({
          canceled: true,
        });
        const [finished] = await f.db`
          select finished_at,settled_output_tokens from allrice_task_calls
          where run_id=${s.task.runId} and native_session_id=${s.nativeSessionId}
            and call_id=${receipt.callId} and kind=${kind}`;
        expect(finished!.finished_at).toBeInstanceOf(Date);
        expect(finished!.settled_output_tokens).toBeNull();
        await expect(handle(receipt)).resolves.toMatchObject({
          canceled: true,
        });
        expect(
          (
            await f.db`select * from allrice_task_progress where run_id=${s.task.runId}`
          )[0],
        ).toEqual(before);
        await expect(
          handle({ ...receipt, outcome: 'success' }),
        ).rejects.toThrow('task_progress_receipt_conflict');
        await expect(
          handle({ ...receipt, callId: 'never-started' }),
        ).rejects.toThrow('task_progress_call_missing');
        await expect(
          handle({ ...receipt, nativeSessionId: randomUUID() }),
        ).rejects.toThrow('task_progress_call_missing');
        for (const raw of [
          { action: 'check', nativeSessionId: s.nativeSessionId },
          {
            action: 'start',
            nativeSessionId: s.nativeSessionId,
            callId: 'new-model-denied',
            kind: 'model',
          },
          {
            action: 'model_prepare',
            nativeSessionId: s.nativeSessionId,
            callId: 'new-prepare-denied',
            requestedOutputTokens: 100,
          },
          {
            action: 'decide',
            nativeSessionId: s.nativeSessionId,
            pauseId: before!.pause_id ?? randomUUID(),
            decision: 'continue',
          },
        ])
          await expect(handle(raw)).rejects.toThrow('task_progress_lease_lost');
        for (const altered of [
          {
            context: { ...s.context, organizationId: randomUUID() },
            worker: s.worker,
          },
          {
            context: s.context,
            worker: { ...s.worker, workerId: randomUUID() },
          },
          {
            context: s.context,
            worker: { ...s.worker, leaseToken: randomUUID() },
          },
        ])
          await expect(
            createTaskProgressRuntime(altered, f.db)(receipt),
          ).rejects.toThrow('task_progress_lease_lost');
        const [job] =
          await f.db`select status,cancel_requested_at from allrice_jobs where id=${s.worker.jobId}`;
        expect(job!.status).toBe('running');
        expect(job!.cancel_requested_at).toBeInstanceOf(Date);
        await f.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${s.worker.jobId}`;
        await expect(handle(receipt)).rejects.toThrow(
          'task_progress_lease_lost',
        );
      },
      30000,
    );
    it('enrolls a task clock without requiring subscription-only billing proof', async () => {
      const s = await setup(false);
      await expect(
        s.port()({ action: 'check', nativeSessionId: s.nativeSessionId }),
      ).resolves.toMatchObject({ paused: false });
      expect(await f.db`select 1 from allrice_task_progress`).toHaveLength(1);
    }, 30000);
  },
);
