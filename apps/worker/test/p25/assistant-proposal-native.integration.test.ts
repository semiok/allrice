/** Real production DSH parent/child + P04 + PostgreSQL. The authenticated
 * Bridge receipt below is synthetic: this is NOT an actual VM command test. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAssistantFixtureDatabase } from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import { createAssistantLocalCommandFixture } from '../../../../packages/database/src/local-command-assistant.fixture.ts';
import { assertAssistantAuthority } from '../../../../packages/database/src/assistant-authority.ts';
import {
  decideRuntimeActionApproval,
  runtimePolicyDigest,
} from '../../../../packages/database/src/runtime-policy.ts';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.js';
import { productionAssistantController } from '../../src/harness/dsh/assistant-controller.js';
import { assertAssistantTaskComplete } from '../../src/harness/dsh/assistant-outcome.js';
import { riceToolDefinitions } from '../../src/tool-broker/definitions.js';
import { p24Fixture } from '../p24/fixture.js';
const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration(
  'P25 actual production native child command proposal → exact P04 → synthetic Bridge fact',
  () => {
    let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      for (const flag of [
        'ALLRICE_ASSISTANTS_ENABLED',
        'ALLRICE_LOCAL_COMMAND_ENABLED',
        'ALLRICE_RUNTIME_POLICY_ENABLED',
        'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
      ])
        vi.stubEnv(flag, '1');
      database = await createAssistantFixtureDatabase();
    }, 120000);
    afterAll(async () => {
      await database?.close();
      vi.unstubAllEnvs();
    });
    it.each(['approved', 'rejected'] as const)(
      'native child proposal is %s without raw native approval',
      async (decision) => {
        const f = await createAssistantLocalCommandFixture(
          database.db,
          'ask',
          true,
          { deferRuntimeRoot: true },
        );
        const tools = riceToolDefinitions.filter((tool) =>
          [
            'assistant.delegate',
            'assistant.report',
            'local.process.execute',
          ].includes(tool.name),
        );
        let childCalls = 0;
        const model = await p24Fixture(async (request) => {
          const text = JSON.stringify(request.messages);
          if (text.includes('ROOT_PRIVATE')) {
            if (!text.includes('COMMAND_CHILD'))
              return {
                nativeTool: {
                  name: 'assistant_delegate',
                  arguments: {
                    label: 'Command helper',
                    text: 'COMMAND_CHILD: submit the exact finite proposal, then report its actual status.',
                    tools: ['assistant.report', 'local.process.execute'],
                  },
                },
              };
            return { text: 'Root synthesis after governed child work.' };
          }
          childCalls++;
          if (childCalls === 1)
            return {
              nativeTool: { name: 'local_process_execute', arguments: f.args },
            };
          return {
            nativeTool: {
              name: 'assistant_report',
              arguments: {
                status: 'partial',
                summary: `Observed governed command response: ${text.slice(-6000)}`,
                evidence: [],
                incomplete: ['Synthetic Bridge fact only; no VM was executed.'],
              },
            },
          };
        });
        vi.stubEnv('ALLRICE_DSH_PLATFORM_HOME', join(model.root, 'platform'));
        const adapter = new DshHarnessAdapter({
          runtimeRoot: join(model.root, 'production-runtime'),
          credentialResolver: {
            resolve: async () => ({ apiKey: 'synthetic-only' }),
          },
        });
        const abort = new AbortController();
        try {
          const execution = adapter.execute({
            kernel: {
              schemaVersion: 1,
              harness: 'dsh',
              employeeAssignmentId: f.assignment,
              employeeVersionId: f.task.frozenConfiguration.employeeVersionId!,
              sessionId: f.session,
              userMessageId: randomUUID(),
              assistantMessageId: randomUUID(),
              systemInstructions: 'Delegate only the specified bounded task.',
              userRequest:
                'ROOT_PRIVATE: delegate COMMAND work and report the exact outcome.',
              bootstrapConversation: '',
              authorizedMemoryContext: '',
              grantedCapabilities: ['model:invoke', 'storage:write'],
              skillVersionIds: [],
              imageAttachments: [],
            },
            providerSnapshot: {
              provider: 'dsh',
              authMode: 'allrice_credential',
              route: 'openai-compatible',
              model: 'p24-synthetic',
              reasoningEffort: 'none',
              credentialReference: 'test:synthetic',
              baseUrl: model.baseUrl,
            },
            storageObjects: [],
            workDirectory: model.root,
            executionEnvironment: {
              ALLRICE_ORGANIZATION_ID: f.org,
              ALLRICE_WORKSPACE_ID: f.workspace,
              ALLRICE_OWNER_ID: f.user,
            },
            signal: abort.signal,
            attempt: 1,
            generation: f.worker.generation,
            maxOutputTokens: 1000,
            threadId: `dsh-${f.session}`,
            tools,
            onEvent: async () => {},
            assistants: productionAssistantController({
              configuration: f.config,
              context: f.context,
              worker: f.worker,
              runLimits: { maxOutputTokens: 6000 },
              tools,
              authorize: assertAssistantAuthority,
              database: database.db,
              signal: abort.signal,
            }),
          });
          execution.catch(() => {});
          await expect
            .poll(
              async () =>
                Number(
                  (
                    await database.db`select count(*) n from allrice_runtime_operations where root_run_id=${f.rootRunId}`
                  )[0]!.n,
                ),
              { timeout: 15000 },
            )
            .toBe(1);
          const [operation] =
            await database.db`select id,initial_snapshot from allrice_runtime_operations where root_run_id=${f.rootRunId}`;
          const operationId = operation!.id;
          const childRunId = operation!.initial_snapshot.agentInstanceId;
          const tree = await f.runtime.getTree(f.requestContext, {
            runId: f.rootRunId,
          });
          expect(
            tree.instances.find((instance) => instance.runId === childRunId),
          ).toMatchObject({
            parentRunId: f.rootRunId,
            allowedTools: ['assistant.report', 'local.process.execute'],
          });
          expect(operation!.initial_snapshot.binding.task.runId).toBe(
            f.rootRunId,
          );
          const ledger = f.freshLedger();
          const dispatch = () =>
            ledger.dispatch({
              scope: f.task.scope,
              operationId,
              leaseOwner: randomUUID(),
              leaseMs: 30000,
            });
          await expect(dispatch()).rejects.toThrow('unavailable');
          expect(childCalls).toBe(1);
          await expect
            .poll(
              async () =>
                Number(
                  (
                    await database.db`select count(*) n from allrice_approval_requests where resource_id=${operationId} and resource_type='runtime_operation'`
                  )[0]!.n,
                ),
              { timeout: 10000 },
            )
            .toBe(1);
          const approval = await f.approvalFor(operationId);
          if (decision === 'approved') {
            await f.approve(approval);
            const lease = await dispatch();
            const identity = {
              scope: f.task.scope,
              operationId,
              leaseToken: lease.leaseToken,
              attempt: lease.snapshot.binding.attempt,
            };
            await ledger.startOperation({
              ...identity,
              receiptId: randomUUID(),
            });
            const fact = {
              kind: 'synthetic_bridge_fixture',
              statement: 'No VM executed',
              nonce: randomUUID(),
            };
            await ledger.recordReceipt({
              ...identity,
              receiptId: randomUUID(),
              signal: {
                type: 'operation.outcome',
                result: {
                  status: 'succeeded',
                  effects: 'none',
                  evidence: {
                    id: randomUUID(),
                    recordedAt: new Date().toISOString(),
                    digest: runtimePolicyDigest(fact),
                  },
                },
              },
              evidence: { summary: 'SYNTHETIC_RECEIPT', output: fact },
            });
            const reservations =
              await database.db`select r.metric,b.unit,b.currency,r.accounting_id,b.source from allrice_runtime_reservations r join allrice_runtime_budgets b using(root_run_id,metric) where r.operation_id=${operationId}`;
            for (const reservation of reservations) {
              const now = new Date().toISOString();
              await ledger.settleUsage({
                ...identity,
                observation: {
                  contractVersion: 1,
                  observationId: randomUUID(),
                  accountingId: reservation.accounting_id,
                  task: lease.snapshot.binding.task,
                  source: reservation.source,
                  accountingBoundary: {
                    kind: 'operation',
                    attempt: identity.attempt,
                  },
                  aggregation: 'self_only',
                  metric: reservation.metric,
                  unit: reservation.unit,
                  currency: reservation.currency,
                  mode: 'cumulative',
                  quality: 'measured',
                  amount: reservation.metric === 'tool_calls' ? 1 : 0,
                  state: 'settled',
                  window: { id: randomUUID(), startedAt: now, endedAt: now },
                  observedAt: now,
                },
              });
            }
          } else {
            await decideRuntimeActionApproval(
              f.requestContext,
              approval.approvalId,
              {
                contractVersion: 1,
                direction: 'response',
                kind: 'action_approval',
                requestId: approval.requestId,
                version: approval.version,
                requestDigest: approval.requestDigest,
                task: approval.task,
                responseId: randomUUID(),
                respondedBy: f.user,
                respondedAt: new Date().toISOString(),
                approvalId: approval.approvalId,
                decision: 'rejected',
              },
              database.db,
            );
          }
          await expect(execution).resolves.toMatchObject({
            answer: expect.stringContaining('Root synthesis'),
            assistantStatus: 'partial',
            costEstimateAvailable: false,
            usageComplete: true,
          });
          // Exactly the completion guard used by executeEmployeeRun after saving
          // a partial answer: the queue must not report ordinary task success.
          const awaitedResult = await execution;
          expect(() => assertAssistantTaskComplete(awaitedResult)).toThrow(
            expect.objectContaining({
              code: 'ASSISTANT_PARTIAL_RESULT',
              retryable: false,
            }),
          );
          const final = await f.runtime.getTree(f.requestContext, {
            runId: f.rootRunId,
          });
          expect(final.cancelRequested).toBe(false);
          expect(
            final.instances.find((instance) => instance.parentRunId === null),
          ).toMatchObject({ status: 'partial', stoppedAt: expect.any(String) });
          expect(final.results).toHaveLength(1);
          expect(final.results[0]).toMatchObject({
            runId: childRunId,
            status: 'partial',
            parentAdoptedSeq: expect.any(Number),
          });
          expect(final.results[0]!.summary).toContain(
            decision === 'approved' ? 'SYNTHETIC_RECEIPT' : 'canceled',
          );
          expect(
            final.instances.every(
              (instance) => instance.cancelRequestedAt === null,
            ),
          ).toBe(true);
        } finally {
          abort.abort();
          await adapter.close();
          await model.close();
        }
      },
      60000,
    );
  },
);
