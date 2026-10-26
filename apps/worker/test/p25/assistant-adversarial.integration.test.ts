/** Independent P25 adversarial review. Real isolated PostgreSQL / native DSH;
 * synthetic model responses are NOT real-model or GA acceptance evidence. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type AssistantResult } from '@allrice/contracts';
import { createAssistantRuntime } from '../../../../packages/database/src/assistant-runtime.ts';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import { createAssistantWorkerBridge } from '../../src/harness/dsh/assistant-bridge.js';
import { confirmToolFailure } from '../../src/errors.js';
import { executeManagedCharts } from '../../src/python/managed-charts.js';
import { PythonExecuteArgsSchema } from '@allrice/contracts';
import type { RiceToolExecutionInput } from '../../src/tool-broker/types.js';
import * as databaseClient from '../../../../packages/database/src/core/client.ts';
import * as employeeDatabase from '@allrice/database';
import { updateEmployeeProfile } from '../../src/tool-broker/handlers/employee-profile.js';
import type { HarnessToolResult } from '../../src/harness/adapter.js';
import { gate, p24Fixture } from '../p24/fixture.js';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const partial = (): AssistantResult => ({
  deliveryId: randomUUID(),
  status: 'partial',
  summary: 'Synthetic incomplete result',
  evidence: [],
  incomplete: ['Synthetic unfinished work'],
  usageComplete: false,
});
integration(
  'P25 independent adversarial ownership, terminal and budget invariants',
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

    it.each([
      'known-read',
      'proposal',
      'unknown-tool',
      'settlement-failed',
      'confirmed-export',
      'foreign-receipt',
      'root-mcp-write',
    ] as const)(
      'accounts a returned query failure without releasing uncertain execution: %s',
      async (mode) => {
        const f = await assistantFixture(database.db);
        if (mode === 'root-mcp-write')
          await database.db`update allrice_assistant_instances set allowed_tools=allowed_tools||'["cloud.mcp.call"]'::jsonb where run_id=${f.task.runId}`;
        const error = new Error('Synthetic handler failure');
        const handler = vi.fn(async (): Promise<HarnessToolResult> => {
          throw error;
        });
        const settle =
          mode === 'settlement-failed'
            ? vi
                .spyOn(f.runtime, 'settleUsage')
                .mockRejectedValue(new Error('Synthetic database unavailable'))
            : undefined;
        const bridge = createAssistantWorkerBridge({
          runtime: f.runtime,
          task: f.task,
          context: f.context,
          worker: f.worker,
          wireNames: {},
          readOnlyTools: new Set(
            ['known-read', 'proposal', 'settlement-failed'].includes(mode)
              ? ['read']
              : mode === 'root-mcp-write'
                ? ['cloud.mcp.call']
                : [],
          ),
          onRootTool: handler,
        });
        const method = mode === 'proposal' ? 'proposal' : 'tool';
        const request = {
          nativeSessionId: f.nativeSessionId,
          callId: randomUUID(),
          name: mode === 'root-mcp-write' ? 'cloud.mcp.call' : 'read',
          arguments: {},
        };
        if (mode === 'confirmed-export' || mode === 'foreign-receipt') {
          // A failed Office attempt before publication, followed by a corrected
          // call, must not poison finalization with unresolved tool accounting.
          confirmToolFailure(error, {
            runId: mode === 'foreign-receipt' ? randomUUID() : f.task.runId,
            callId: request.callId,
            toolName: request.name,
          });
        }
        await expect(bridge.handle(method, request)).rejects.toThrow(
          mode === 'settlement-failed'
            ? 'Synthetic database unavailable'
            : error,
        );
        settle?.mockRestore();
        const rows =
          await database.db`select metric,settled_amount,result_digest from allrice_assistant_usage where root_run_id=${f.task.runId}`;
        expect(rows).toHaveLength(4);
        for (const row of rows) {
          if (mode === 'known-read' || mode === 'confirmed-export') {
            expect(Number(row.settled_amount)).toBe(
              row.metric === 'tool_calls' ? 1 : 0,
            );
            expect(row.result_digest).toMatch(/^sha256:/);
          } else {
            expect(row.settled_amount).toBeNull();
            expect(row.result_digest).toBeNull();
          }
        }
        // Transport duplicates never execute the tool a second time, including
        // an already-accounted failure. A model retry uses a fresh call ID.
        await expect(bridge.handle(method, request)).rejects.toThrow();
        expect(handler).toHaveBeenCalledTimes(1);
        if (mode === 'confirmed-export') {
          handler.mockImplementation(async () => ({
            modelContent: 'Corrected export',
            summary: 'Corrected export',
          }));
          await bridge.handle('tool', { ...request, callId: randomUUID() });
          expect(handler).toHaveBeenCalledTimes(2);
        }
        const complete = mode === 'known-read' || mode === 'confirmed-export';
        expect(await f.runtime.finalizeRoot(f.base)).toMatchObject({
          status: complete ? 'completed' : 'unknown',
          usageComplete: complete,
        });
      },
    );

    it('finalizes a real Python pre-dispatch refusal followed by correction without unresolved usage', async () => {
      const f = await assistantFixture(database.db);
      await database.db`update allrice_assistant_instances set allowed_tools=allowed_tools||'["python.execute"]'::jsonb where run_id=${f.task.runId}`;
      const db = vi
        .spyOn(databaseClient, 'getDatabase')
        .mockReturnValue(database.db);
      let corrected = false;
      try {
        const bridge = createAssistantWorkerBridge({
          runtime: f.runtime,
          task: f.task,
          context: f.context,
          worker: f.worker,
          wireNames: {},
          readOnlyTools: new Set(),
          onRootTool: async (call) => {
            if (corrected)
              return {
                modelContent: 'corrected computation',
                summary: 'corrected computation',
              };
            await executeManagedCharts(
              {
                context: {
                  executionId: randomUUID(),
                  runId: f.task.runId,
                  jobId: f.worker.jobId,
                  worker: { type: 'worker', id: f.worker.workerId },
                  delegatedBy: { type: 'user', id: f.context.actor.id },
                  organizationId: f.context.organizationId,
                  workspaceId: f.context.workspaceId,
                  startedAt: new Date().toISOString(),
                  policySnapshot: {
                    id: randomUUID(),
                    organizationId: f.context.organizationId,
                    subjectId: f.context.actor.id,
                    version: 1,
                    issuedAt: new Date().toISOString(),
                    expiresAt: new Date(Date.now() + 600000).toISOString(),
                    memberships: f.context.memberships,
                    grants: [],
                  },
                },
                capabilities: [],
                storageRoot: database.storageRoot,
                call,
              } satisfies RiceToolExecutionInput,
              PythonExecuteArgsSchema.parse(call.arguments),
            );
            throw Error('missing lease must reject');
          },
        });
        const request = {
          nativeSessionId: f.nativeSessionId,
          callId: randomUUID(),
          name: 'python.execute',
          arguments: { script: 'print(1)' },
        };
        await expect(bridge.handle('tool', request)).rejects.toMatchObject({
          code: 'PYTHON_EXECUTION_UNAVAILABLE',
        });
        corrected = true;
        await bridge.handle('tool', { ...request, callId: randomUUID() });
        const rows =
          await database.db`select metric,settled_amount from allrice_assistant_usage where root_run_id=${f.task.runId}`;
        expect(rows).toHaveLength(8);
        expect(rows.every((r) => r.settled_amount !== null)).toBe(true);
        expect(await f.runtime.finalizeRoot(f.base)).toMatchObject({
          status: 'completed',
          usageComplete: true,
        });
      } finally {
        db.mockRestore();
      }
    });

    it.each(['conflict', 'intent', 'unknown-commit'] as const)(
      'settles only confirmed personal-profile refusal through the real governed bridge: %s',
      async (mode) => {
        const f = await assistantFixture(database.db),
          name = 'workspace.employee.profile.update';
        await database.db`update allrice_assistant_instances set allowed_tools=allowed_tools||${database.db.json([name])}::jsonb where run_id=${f.task.runId}`;
        // Database transactions have separate real-PG coverage. Inject their
        // exact error classes here to test the production handler/bridge ledger.
        const failure =
          mode === 'conflict'
            ? new employeeDatabase.EmployeeInstanceError('instance_conflict')
            : mode === 'intent'
              ? new employeeDatabase.EmployeeProfileChatError(
                  'explicit_profile_request_required',
                )
              : new Error('Connection lost during commit');
        const stub = vi
          .spyOn(employeeDatabase, 'updateEmployeeProfileFromChat')
          .mockRejectedValue(failure);
        try {
          const bridge = createAssistantWorkerBridge({
            runtime: f.runtime,
            task: f.task,
            context: f.context,
            worker: f.worker,
            wireNames: {},
            readOnlyTools: new Set(),
            onRootTool: (call) =>
              updateEmployeeProfile({
                input: {
                  context: { runId: f.task.runId },
                  sessionId: f.task.chatSessionId!,
                  userMessageId: randomUUID(),
                  call,
                  managedBrowserJobAttempt: 0,
                  managedBrowserJobLeaseToken: f.worker.leaseToken,
                },
                arguments: call.arguments,
              } as Parameters<typeof updateEmployeeProfile>[0]),
          });
          await expect(
            bridge.handle('tool', {
              nativeSessionId: f.nativeSessionId,
              callId: randomUUID(),
              name,
              arguments: { expectedRevision: 1, name: '小禾' },
            }),
          ).rejects.toThrow();
          expect(stub).toHaveBeenCalledTimes(1);
          expect(await f.runtime.finalizeRoot(f.base)).toMatchObject({
            status: mode === 'unknown-commit' ? 'unknown' : 'completed',
          });
        } finally {
          stub.mockRestore();
        }
      },
    );

    it('rejects invented artifact identity/digest rather than minting completed evidence', async () => {
      const f = await assistantFixture(database.db),
        child = (await f.delegate()).instance;
      await expect(
        f.runtime.registerArtifact({
          ...f.base,
          runId: child.runId,
          relativePath: 'invented.txt',
          artifactId: randomUUID(),
          digest: `sha256:${'f'.repeat(64)}`,
        }),
      ).rejects.toThrow();
    });

    it('keeps child-canceled late evidence without granting parent wake', async () => {
      const f = await assistantFixture(database.db),
        child = (await f.delegate()).instance;
      await f.runtime.cancelChild(f.context, {
        runId: f.task.runId,
        childRunId: child.runId,
        requestId: randomUUID(),
      });
      expect(
        await f.runtime.recordResult({
          ...f.base,
          runId: child.runId,
          result: partial(),
        }),
      ).toMatchObject({ wakeParent: false });
    });

    it('a settlement racing a canceled child report delivers that report instead of a conflict', async () => {
      const f = await assistantFixture(database.db),
        child = (await f.delegate()).instance,
        report = partial();
      await f.runtime.cancelChild(f.context, {
        runId: f.task.runId,
        childRunId: child.runId,
        requestId: randomUUID(),
      });
      const bridge = createAssistantWorkerBridge({
        runtime: {
          ...f.runtime,
          // Cancellation released the native wait for the child's report, but
          // the Worker still commits it, and then the stop receipt, between
          // the settlement's read and its fallback write.
          async resultDelivery(input) {
            const delivery = await f.runtime.resultDelivery(input);
            await f.runtime.recordResult({
              ...f.base,
              runId: child.runId,
              result: report,
            });
            await f.runtime.confirmStopped({ ...f.base, runId: child.runId });
            return delivery;
          },
        },
        task: f.task,
        context: f.context,
        worker: f.worker,
        wireNames: {},
        readOnlyTools: new Set(),
      });
      await expect(
        bridge.handle('settled', {
          nativeSessionId: child.nativeSessionId,
          stopReason: 'native_settled',
        }),
      ).resolves.toMatchObject({
        deliveryId: report.deliveryId,
        wakeParent: false,
      });
      const rows =
        await database.db`select delivery_id from allrice_assistant_results where run_id=${child.runId}`;
      expect(rows.map((row) => row.delivery_id)).toEqual([report.deliveryId]);
    });

    it('does not rewrite a terminal child Run via a fresh delivery ID', async () => {
      const f = await assistantFixture(database.db),
        child = (await f.delegate()).instance;
      await f.runtime.recordResult({
        ...f.base,
        runId: child.runId,
        result: { ...partial(), status: 'failed' },
      });
      try {
        await f.runtime.recordResult({
          ...f.base,
          runId: child.runId,
          result: { ...partial(), status: 'canceled' },
        });
      } catch {
        /* Rejecting the conflicting new delivery is acceptable. */
      }
      const [run] =
        await database.db`select state from allrice_runs where id=${child.runId}`;
      expect(run!.state).toBe('failed');
      expect(
        (
          await f.runtime.getTree(f.context, { runId: f.task.runId })
        ).instances.find((row) => row.runId === child.runId)?.status,
      ).toBe('failed');
    });

    it.each(
      (
        [
          'cancelRoot',
          'cancelChild',
          'assistant_stop',
          'budget_exhausted',
        ] as const
      ).flatMap((trigger) =>
        (['settlement-first', 'stopped-first'] as const).map((order) => ({
          trigger,
          order,
        })),
      ),
    )(
      'reconciles canceled child settlement and Run state: $trigger, $order',
      async ({ trigger, order }) => {
        const f = await assistantFixture(database.db, 12, {
          allowedTools: [
            'read',
            'assistant.delegate',
            'assistant.report',
            'assistant.stop',
          ],
        });
        const child = (
          await f.delegate({ label: 'A', tools: ['read', 'assistant.report'] })
        ).instance;
        const sibling = (await f.delegate({ label: 'B' })).instance;
        const bridge = createAssistantWorkerBridge({
          runtime: f.runtime,
          task: f.task,
          context: f.context,
          worker: f.worker,
          wireNames: {},
          readOnlyTools: new Set(),
        });
        const state = async () =>
          database.db`select i.status,i.stopped_at,r.state from allrice_assistant_instances i join allrice_runs r on r.id=i.run_id where i.run_id=${child.runId}`;
        const settle = () =>
          bridge.handle('settled', {
            nativeSessionId: child.nativeSessionId,
            stopReason: 'native_settled',
          });
        if (trigger === 'cancelRoot')
          await f.runtime.cancelRoot(f.context, {
            runId: f.task.runId,
            requestId: randomUUID(),
          });
        else if (trigger === 'cancelChild')
          await f.runtime.cancelChild(f.context, {
            runId: f.task.runId,
            childRunId: child.runId,
            requestId: randomUUID(),
          });
        else if (trigger === 'assistant_stop')
          await bridge.handle('stop', {
            nativeSessionId: f.nativeSessionId,
            callId: randomUUID(),
            arguments: { childRunId: child.runId },
          });
        else {
          // Calls/tokens are observational. Exhaust the real time budget so
          // authority polling commits the production budget_exhausted cutoff.
          await database.db`update allrice_jobs set created_at=clock_timestamp()-interval '2 seconds',timeout_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
          await expect(
            f.runtime.assertCurrentAuthority(f.base),
          ).resolves.toMatchObject({
            cancelRequested: true,
            stopReason: 'timeout',
          });
          const [root] =
            await database.db`select cancel_reason from allrice_runtime_roots where root_run_id=${f.task.runId}`;
          expect(root!.cancel_reason).toBe('budget_exhausted');
        }
        const pending = [
          { status: 'cancel_requested', stopped_at: null, state: 'running' },
        ];
        expect(await state()).toEqual(pending);
        let deliveryId: unknown;
        if (order === 'settlement-first') {
          const receipt = await settle();
          expect(receipt).toMatchObject({
            deliveryId: expect.any(String),
            status: 'partial',
            wakeParent: false,
          });
          deliveryId = receipt.deliveryId;
          // Settlement is evidence, not confirmation that the process stopped.
          expect(await state()).toEqual(pending);
        }
        await expect(
          bridge.handle('stopped', { nativeSessionId: child.nativeSessionId }),
        ).resolves.toEqual({ stopped: true });
        const stopped = await state();
        expect(stopped).toEqual([
          {
            status: 'canceled',
            stopped_at: expect.any(Date),
            state: 'canceled',
          },
        ]);
        // Transport duplicates neither fabricate receipts nor mutate stop proof.
        for (let duplicate = 0; duplicate < 2; duplicate++) {
          const receipt = await settle();
          if (order === 'stopped-first')
            expect(receipt).toEqual({ status: 'canceled', wakeParent: false });
          else
            expect(receipt).toMatchObject({
              deliveryId,
              status: 'partial',
              wakeParent: false,
            });
        }
        expect(await state()).toEqual(stopped);
        const results =
          await database.db`select delivery_id,payload,parent_adopted_seq from allrice_assistant_results where root_run_id=${f.task.runId}`;
        expect(results).toHaveLength(order === 'settlement-first' ? 1 : 0);
        if (results.length) {
          expect(results[0]).toMatchObject({
            delivery_id: deliveryId,
            payload: { status: 'partial', usageComplete: false },
            parent_adopted_seq: null,
          });
          await expect(
            bridge.handle('adopt-result', {
              nativeSessionId: f.nativeSessionId,
              deliveryId,
              nativeMessageId: randomUUID(),
              adoptedSeq: 1,
            }),
          ).rejects.toThrow(
            trigger === 'budget_exhausted'
              ? 'lease_lost'
              : trigger === 'cancelRoot'
                ? 'canceled'
                : 'not_found',
          );
        }
        await expect(
          f.runtime.recordResult({
            ...f.base,
            runId: child.runId,
            result: partial(),
          }),
        ).rejects.toThrow('conflict');
        if (trigger === 'cancelChild' || trigger === 'assistant_stop') {
          const tree = await bridge.tree();
          for (const runId of [f.task.runId, sibling.runId]) {
            expect(
              tree.instances.find((row) => row.runId === runId),
            ).toMatchObject({
              cancelRequestedAt: null,
              stoppedAt: null,
            });
            const [run] =
              await database.db`select state from allrice_runs where id=${runId}`;
            expect(run!.state).toBe('running');
          }
        }
      },
    );

    it('keeps an existing settlement idempotent across stop without hiding conflicting deliveries', async () => {
      const f = await assistantFixture(database.db),
        child = (await f.delegate({ tools: ['read', 'assistant.report'] }))
          .instance,
        result = partial();
      const bridge = createAssistantWorkerBridge({
        runtime: f.runtime,
        task: f.task,
        context: f.context,
        worker: f.worker,
        wireNames: {},
        readOnlyTools: new Set(),
      });
      const report = () =>
        bridge.handle('report', {
          nativeSessionId: child.nativeSessionId,
          callId: randomUUID(),
          arguments: {
            status: 'partial',
            summary: 'Late report',
            evidence: [],
            incomplete: ['Unfinished'],
          },
        });
      const record = (delivery = result) =>
        f.runtime.recordResult({
          ...f.base,
          runId: child.runId,
          result: delivery,
          settlement: true,
        });
      await expect(record()).resolves.toMatchObject({
        duplicate: false,
        status: 'partial',
        wakeParent: true,
      });
      const duplicate = {
        duplicate: true,
        recorded: true,
        status: 'partial',
        wakeParent: false,
      };
      await expect(record()).resolves.toEqual(duplicate);
      // The real tool is refused at admission; direct ledger reports still
      // reach the stricter terminal/delivery conflict check.
      await expect(report()).rejects.toThrow('canceled');
      await expect(
        f.runtime.recordResult({
          ...f.base,
          runId: child.runId,
          result: partial(),
        }),
      ).rejects.toThrow('conflict');
      await f.runtime.cancelChild(f.context, {
        runId: f.task.runId,
        childRunId: child.runId,
        requestId: randomUUID(),
      });
      await f.runtime.confirmStopped({ ...f.base, runId: child.runId });
      await expect(record()).resolves.toEqual(duplicate);
      await expect(report()).rejects.toThrow('canceled');
      await expect(
        record({ ...result, summary: 'Changed payload' }),
      ).rejects.toThrow('conflict');
      // Under another delivery ID a settlement only finds the existing one.
      await expect(
        record({ ...result, deliveryId: randomUUID() }),
      ).resolves.toMatchObject({
        recorded: false,
        result: { deliveryId: result.deliveryId },
        wakeParent: false,
      });
      const tree = await f.runtime.getTree(f.context, { runId: f.task.runId });
      expect(tree.results).toMatchObject([{ deliveryId: result.deliveryId }]);
      expect(tree.results).toHaveLength(1);
      expect(
        tree.instances.find((row) => row.runId === child.runId),
      ).toMatchObject({
        status: 'partial',
        stoppedAt: expect.any(String),
      });
      const [run] =
        await database.db`select state from allrice_runs where id=${child.runId}`;
      expect(run!.state).toBe('failed');
    });

    it.each(['expired', 'replaced', 'quarantined'] as const)(
      'does not acknowledge a stopped-child settlement under a %s lease',
      async (loss) => {
        const f = await assistantFixture(database.db),
          child = (await f.delegate()).instance;
        const bridge = createAssistantWorkerBridge({
          runtime: f.runtime,
          task: f.task,
          context: f.context,
          worker: f.worker,
          wireNames: {},
          readOnlyTools: new Set(),
        });
        await f.runtime.cancelRoot(f.context, {
          runId: f.task.runId,
          requestId: randomUUID(),
        });
        await f.runtime.confirmStopped({ ...f.base, runId: child.runId });
        if (loss === 'replaced')
          await database.db`update allrice_jobs set lease_token=${randomUUID()} where id=${f.worker.jobId}`;
        else {
          await database.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
          if (loss === 'quarantined') await f.runtime.quarantineExpired(f.base);
        }
        await expect(
          bridge.handle('settled', { nativeSessionId: child.nativeSessionId }),
        ).rejects.toThrow('lease_lost');
        await expect(
          f.runtime.recordResult({
            ...f.base,
            runId: child.runId,
            result: partial(),
            settlement: true,
          }),
        ).rejects.toThrow('lease_lost');
        const results =
          await database.db`select 1 from allrice_assistant_results where root_run_id=${f.task.runId}`;
        expect(results).toHaveLength(0);
        const [row] =
          await database.db`select i.status,i.stopped_at,r.state from allrice_assistant_instances i join allrice_runs r on r.id=i.run_id where i.run_id=${child.runId}`;
        expect(row).toEqual({
          status: 'canceled',
          stopped_at: expect.any(Date),
          state: 'canceled',
        });
      },
    );

    it('cannot omit an exhausted token dimension to admit a model call', async () => {
      const f = await assistantFixture(database.db),
        child = (await f.delegate()).instance;
      await database.db`update allrice_runtime_budgets set capacity=0 where root_run_id=${f.task.runId} and metric='input_tokens'`;
      await expect(
        f.runtime.reserveUsage({
          ...f.base,
          runId: child.runId,
          kind: 'model',
          callId: randomUUID(),
          amounts: { model_calls: 1 },
        }),
      ).rejects.toThrow();
    });

    it('usage overage does not produce cancellation tombstones', async () => {
      const f = await assistantFixture(database.db),
        child = (await f.delegate()).instance,
        callId = randomUUID();
      await f.runtime.reserveUsage({
        ...f.base,
        runId: child.runId,
        kind: 'model',
        callId,
        amounts: {
          model_calls: 1,
          tool_calls: 0,
          input_tokens: 1,
          output_tokens: 1,
        },
      });
      await f.runtime.settleUsage({
        ...f.base,
        callId,
        amounts: {
          model_calls: 1,
          tool_calls: 0,
          input_tokens: 100001,
          output_tokens: 1,
        },
      });
      const tree = await f.runtime.getTree(f.context, { runId: f.task.runId });
      expect(tree.cancelRequested).toBe(false);
      expect(
        tree.instances.every((row) => row.cancelRequestedAt === null),
      ).toBe(true);
    });

    it('rechecks the Worker lease after a slow authority decision and before reservation commit', async () => {
      const f = await assistantFixture(database.db),
        child = (await f.delegate()).instance;
      const runtime = createAssistantRuntime({
        database: database.db,
        authorize: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1100));
        },
      });
      await database.db`update allrice_jobs set lease_expires_at=clock_timestamp()+interval '700 milliseconds' where id=${f.worker.jobId}`;
      await expect(
        runtime.reserveUsage({
          ...f.base,
          runId: child.runId,
          kind: 'model',
          callId: randomUUID(),
          amounts: {
            model_calls: 1,
            tool_calls: 0,
            input_tokens: 1,
            output_tokens: 1,
          },
        }),
      ).rejects.toThrow('lease_lost');
    });

    it('rejects conflicting durable/adoption sequence observations for the same native message', async () => {
      const f = await assistantFixture(database.db),
        inputId = randomUUID(),
        nativeMessageId = randomUUID();
      await f.delegate({ delegationId: inputId });
      await f.runtime.claimMessage({ ...f.base, inputId });
      await f.runtime.checkpointMessage({
        ...f.base,
        inputId,
        nativeMessageId,
        durableSeq: 3,
        adoptedSeq: 4,
      });
      await expect(
        f.runtime.checkpointMessage({
          ...f.base,
          inputId,
          nativeMessageId,
          durableSeq: 99,
          adoptedSeq: 100,
        }),
      ).rejects.toThrow('conflict');
    });

    it('rejects an empty native adoption identity rather than allowing a later overwrite', async () => {
      const f = await assistantFixture(database.db),
        child = (await f.delegate()).instance,
        result = partial();
      await f.runtime.recordResult({ ...f.base, runId: child.runId, result });
      await expect(
        f.runtime.adoptResult({
          ...f.base,
          parentRunId: f.task.runId,
          deliveryId: result.deliveryId,
          nativeMessageId: '',
          adoptedSeq: 2,
        }),
      ).rejects.toThrow();
    });

    it('the existing StopRun job tombstone blocks new assistant calls before heartbeat propagation', async () => {
      const f = await assistantFixture(database.db),
        child = (await f.delegate()).instance;
      await database.db`update allrice_jobs set cancel_requested_at=clock_timestamp(),cancel_reason='Synthetic user stop' where id=${f.worker.jobId}`;
      await expect(
        f.runtime.reserveUsage({
          ...f.base,
          runId: child.runId,
          kind: 'model',
          callId: randomUUID(),
          amounts: {
            model_calls: 1,
            tool_calls: 0,
            input_tokens: 1,
            output_tokens: 1,
          },
        }),
      ).rejects.toThrow();
    });

    it('a native sibling identity cannot checkpoint another child input', async () => {
      const f = await assistantFixture(database.db),
        first = (await f.delegate()).instance,
        secondInputId = randomUUID();
      await f.delegate({ delegationId: secondInputId });
      await f.runtime.claimMessage({ ...f.base, inputId: secondInputId });
      const bridge = createAssistantWorkerBridge({
        runtime: f.runtime,
        task: f.task,
        context: f.context,
        worker: f.worker,
        wireNames: {},
        readOnlyTools: new Set(),
      });
      await expect(
        bridge.handle('checkpoint', {
          nativeSessionId: first.nativeSessionId,
          inputId: secondInputId,
          nativeMessageId: randomUUID(),
          durableSeq: 1,
          adoptedSeq: 2,
        }),
      ).rejects.toThrow();
      expect(
        (await bridge.tree()).messages.find(
          (message) => message.inputId === secondInputId,
        )?.status,
      ).toBe('dispatching');
    });

    it('overage leaves the native stream running; explicit cancellation drains it and prevents a late wake', async () => {
      const f = await assistantFixture(database.db),
        hold = gate();
      const bridge = createAssistantWorkerBridge({
        runtime: f.runtime,
        task: f.task,
        context: f.context,
        worker: f.worker,
        wireNames: { read: 'p24_proposal' },
        readOnlyTools: new Set(),
      });
      const native = await p24Fixture(
        async () => {
          await hold.promise;
          return {
            text: 'Late synthetic response must not wake another model turn.',
          };
        },
        undefined,
        { p25: true, callback: bridge.handle },
      );
      const client = native.launch();
      try {
        await client.call('ready');
        await client.call('create', { id: f.nativeSessionId });
        await client.call('p25/bind', { nativeSessionId: f.nativeSessionId });
        const inputId = randomUUID();
        await f.delegate({ delegationId: inputId });
        await client.call('p25/start', await bridge.messageDispatch(inputId));
        await expect.poll(() => native.requests.length).toBe(1);
        // Independent already-completed metered call discovers a real overrun
        // while the native child has an in-flight HTTP/model stream.
        const callId = randomUUID();
        await f.runtime.reserveUsage({
          ...f.base,
          runId: f.task.runId,
          kind: 'model',
          callId,
          amounts: {
            model_calls: 1,
            tool_calls: 0,
            input_tokens: 1,
            output_tokens: 1,
          },
        });
        await f.runtime.settleUsage({
          ...f.base,
          callId,
          amounts: {
            model_calls: 1,
            tool_calls: 0,
            input_tokens: 100001,
            output_tokens: 1,
          },
        });
        expect((await bridge.tree()).cancelRequested).toBe(false);
        await f.runtime.cancelRoot(f.context, {
          runId: f.task.runId,
          requestId: randomUUID(),
        });
        const cancellation = await bridge.cancellation();
        expect(cancellation.instances.length).toBeGreaterThan(0);
        await client.call('p25/drain', cancellation);
        hold.release();
        await client.call('p25/flush');
        expect(native.requests).toHaveLength(1);
        expect(
          (await bridge.tree()).instances.every(
            (row) => row.status === 'canceled' && row.stoppedAt !== null,
          ),
        ).toBe(true);
      } finally {
        hold.release();
        await native.close();
      }
    }, 60000);

    it('native calls continue past old capacity and retain truthful usage through explicit stop', async () => {
      const f = await assistantFixture(database.db);
      const bridge = createAssistantWorkerBridge({
        runtime: f.runtime,
        task: f.task,
        context: f.context,
        worker: f.worker,
        wireNames: {},
        readOnlyTools: new Set(),
      });
      const native = await p24Fixture(
        async () => ({ text: 'Synthetic known reply' }),
        undefined,
        { p25: true, callback: bridge.handle },
      );
      const client = native.launch();
      try {
        await client.call('ready');
        await client.call('create', { id: f.nativeSessionId });
        await client.call('p25/bind', { nativeSessionId: f.nativeSessionId });
        await client.call('prompt', {
          id: f.nativeSessionId,
          text: 'First synthetic call',
        });
        await client.call('idle', { id: f.nativeSessionId });
        await client.call('p25/flush');
        await database.db`update allrice_runtime_budgets set capacity=spent where root_run_id=${f.task.rootRunId} and metric='input_tokens'`;
        await client
          .call('prompt', {
            id: f.nativeSessionId,
            text: 'Second call proceeds beyond the old token allowance',
          })
          .catch(() => {});
        await client.call('idle', { id: f.nativeSessionId });
        await client.call('p25/flush');
        expect(native.requests).toHaveLength(2);
        const admissions =
          await database.db`select dispatched_at from allrice_assistant_model_admissions where root_run_id=${f.task.rootRunId}`;
        expect(admissions).toHaveLength(2);
        expect(admissions.filter((a) => a.dispatched_at === null)).toHaveLength(
          0,
        );
        await f.runtime.cancelRoot(f.context, {
          runId: f.task.runId,
          requestId: randomUUID(),
        });
        await client.call('p25/drain', await bridge.cancellation());
        await client.call('p25/flush');
        expect(await f.runtime.readFailureUsage(f.base)).toEqual({
          usage: { inputTokens: 40, cachedInputTokens: 0, outputTokens: 10 },
          usageComplete: true,
          cacheUsageKnown: false,
        });
        expect(
          (await bridge.tree()).instances.every((i) => i.stoppedAt !== null),
        ).toBe(true);
        expect(native.requests).toHaveLength(2);
      } finally {
        await native.close();
      }
    }, 60000);
  },
);
