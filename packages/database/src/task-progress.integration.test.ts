import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RouteDecisionSchema,
  resolveAssistantSubscriptionSnapshot,
  defaultAssistantRunConfiguration,
} from '@allrice/contracts';
import { createP27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { recordRouteDecision } from './execution/route-decision.ts';
import { freezeRouteSubscriptionSnapshot } from './execution/route-subscription.ts';
import { createTaskProgressRuntime } from './task-progress.ts';
import { readTaskClock } from './task-clock.ts';
import { createRuntimeOperationLedger } from './runtime-ledger/ledger.ts';
import { createAssistantRuntime } from './assistant-runtime.ts';
import { listDshRuntimeEventTimeline } from './conversation/conversation-runtime.ts';

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
      vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
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
        const snapshot = resolveAssistantSubscriptionSnapshot({
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
      return { task, context, worker, port, nativeSessionId };
    }
    it('crosses 16/64/80 for real parent/child admissions, then pauses, survives rebind and resumes without erasing counts', async () => {
      const s = await setup(),
        handle = s.port();
      await handle({ action: 'check', nativeSessionId: s.nativeSessionId });
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      const task = {
        scope: {
          organizationId: f.organizationId,
          workspaceId: f.workspaceId,
          projectId: null,
        },
        rootRunId: s.task.runId,
        runId: s.task.runId,
        parentRunId: null,
        chatSessionId: s.task.sessionId,
        frozenConfiguration: {
          employeeVersionId: null,
          digest: `sha256:${'a'.repeat(64)}`,
        },
      };
      const ledger = createRuntimeOperationLedger({
        database: f.db,
        admission: async () => {},
      });
      await ledger.createRoot({
        task,
        deadlineAt: s.task.execution.job.timeoutAt,
        budgets: (
          [
            { metric: 'model_calls', capacity: 16 },
            { metric: 'tool_calls', capacity: 64 },
            { metric: 'input_tokens', capacity: 100000 },
            { metric: 'output_tokens', capacity: 100000 },
          ] as const
        ).map((b) => ({
          ...b,
          unit: b.metric.endsWith('tokens') ? 'tokens' : 'calls',
          currency: null,
          source: { kind: 'worker' as const, sourceId: 'met153-test' },
        })),
      });
      const runtime = createAssistantRuntime({
          database: f.db,
          authorize: async () => {},
        }),
        worker = { ...s.worker, generation: 1 },
        base = { scope: task.scope, rootRunId: task.rootRunId, worker };
      await runtime.configureRoot({
        task,
        configuration: {
          ...defaultAssistantRunConfiguration(),
          allowAssistants: true,
        },
        nativeSessionId: s.nativeSessionId,
        worker,
        allowedTools: ['read', 'assistant.delegate'],
      });
      const child = (
        await runtime.provision({
          ...base,
          parentRunId: task.runId,
          delegationId: randomUUID(),
          label: 'Read',
          text: 'Synthetic read',
          tools: ['read'],
        })
      ).instance;
      for (let i = 0; i < 81; i++) {
        const runId = i % 2 ? task.runId : child.runId,
          callId = randomUUID();
        await runtime.prepareModelUsage({
          ...base,
          runId,
          callId,
          requestedOutputTokens: 10,
        });
        await runtime.dispatchModelUsage({
          ...base,
          runId,
          callId,
          inputTokens: 10,
          outputTokens: 10,
          requestDigest: `sha256:${'1'.repeat(64)}`,
        });
        await runtime.settleUsage({
          ...base,
          runId,
          callId,
          amounts: {
            model_calls: 1,
            tool_calls: 0,
            input_tokens: 10,
            output_tokens: 5,
          },
        });
        const toolId = randomUUID();
        await runtime.reserveUsage({
          ...base,
          runId,
          callId: toolId,
          kind: 'tool',
          tool: 'read',
          amounts: {
            model_calls: 0,
            tool_calls: 1,
            input_tokens: 0,
            output_tokens: 0,
          },
        });
        await runtime.settleUsage({
          ...base,
          runId,
          callId: toolId,
          amounts: {
            model_calls: 0,
            tool_calls: 1,
            input_tokens: 0,
            output_tokens: 0,
          },
        });
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
      const tree = await runtime.getTree(f.context, { runId: task.runId });
      expect(
        tree.budgets.find((b) => b.metric === 'model_calls'),
      ).toMatchObject({ spent: 81, enforced: false });
      expect(tree.budgets.find((b) => b.metric === 'tool_calls')).toMatchObject(
        { spent: 81, enforced: false },
      );
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
        await resumed({ action: 'check', nativeSessionId: s.nativeSessionId }),
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
    }, 60000);
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
    it('refuses an unverified route even with a new clock', async () => {
      const s = await setup(false);
      await expect(
        s.port()({ action: 'check', nativeSessionId: s.nativeSessionId }),
      ).rejects.toThrow('task_progress_subscription_required');
      expect(await f.db`select 1 from allrice_task_progress`).toHaveLength(0);
    }, 30000);
  },
);
