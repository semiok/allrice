/** Production DSH child orchestration + PostgreSQL + exact approval. The
 * provider and Bridge identity are synthetic; VM execution is separately opt-in.
 * This is NOT a real tenant/browser/M5 acceptance claim. */
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  RuntimeLocalCommandSchema,
  localCommandToolchainImageV1,
} from '@allrice/contracts';
import {
  createAssistantFixtureDatabase,
  assistantFixtureStorage,
} from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import { createAssistantLocalCommandFixture } from '../../../../packages/database/src/local-command-assistant.fixture.ts';
import { assertAssistantAuthority } from '../../../../packages/database/src/assistant-authority.ts';
import { publishWorkbenchChangesetProposal } from '../../../../packages/database/src/artifact-review.ts';
import { reportLocalCommandProfile } from '../../../../packages/database/src/local-command-profile.ts';
import { localCommandCandidateEvidence } from '../../../../packages/database/src/local-command-candidate.ts';
import { LocalCommandRunner } from '../../../rice-bridge/src/local-command-runner.js';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.js';
import { productionAssistantController } from '../../src/harness/dsh/assistant-controller.js';
import { riceToolDefinitions } from '../../src/tool-broker/definitions.js';
import { p24Fixture } from '../p24/fixture.js';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const hash = (text: string) =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;
suite(
  'MET-144 native writer → exact-version tester → independent reviewer → root delivery',
  () => {
    let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      for (const flag of [
        'ASSISTANTS',
        'LOCAL_COMMAND',
        'RUNTIME_POLICY',
        'BRIDGE_OPERATION_LEDGER',
        'WORKBENCH',
        'CHANGESET',
      ])
        vi.stubEnv(`ALLRICE_${flag}_ENABLED`, '1');
      database = await createAssistantFixtureDatabase();
    }, 120000);
    afterAll(async () => {
      await database?.close();
      vi.unstubAllEnvs();
    });
    it.each(
      process.env.ALLRICE_LOCAL_DOCKER_TEST_SOCKET
        ? (['synthetic', 'vm', 'missing-delivery'] as const)
        : (['synthetic', 'missing-delivery'] as const),
    )(
      'completes the governed pipeline (%s command)',
      async (mode) => {
        const f = await createAssistantLocalCommandFixture(
          database.db,
          'ask',
          false,
          { deferRuntimeRoot: true, development: true },
        );
        const storage = assistantFixtureStorage(f.db);
        await reportLocalCommandProfile(
          f.device,
          {
            contractVersion: 1,
            backend: 'local-vm-container-v1',
            architecture: 'amd64',
            imageDigest: localCommandToolchainImageV1,
            available: true,
            features: ['changeset_candidate'],
          },
          f.db,
        );
        const original = 'throw Error("original file must not run");',
          changed = 'console.log("SAME_VERSION_VM_PASSED");';
        const seedArtifact = await publishWorkbenchChangesetProposal(
          {
            context: f.context,
            sessionId: f.session,
            callId: randomUUID(),
            fileName: 'seed.json',
            proposal: {
              files: [{ path: 'test.mjs', before: original, after: original }],
            },
          },
          storage,
          f.db,
        );
        const seed = {
          artifactId: seedArtifact.id,
          digest: seedArtifact.object.checksum!,
        };
        const tools = riceToolDefinitions.filter((t) =>
          [
            'assistant.delegate',
            'assistant.report',
            'assistant.development',
            'local.process.execute',
          ].includes(t.name),
        );
        let rootStep = 0,
          writerStep = 0,
          testerStep = 0,
          reviewerStep = 0;
        let reviewerSawCode = false;
        let reviewerSawTest = false;
        const waitFor = async <T>(
          read: () => Promise<T | undefined>,
        ): Promise<T> => {
          const until = Date.now() + 20000;
          while (Date.now() < until) {
            const value = await read();
            if (value !== undefined) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          throw Error('Synthetic choreography timed out');
        };
        const currentHead = async () => {
          const [h] =
            await f.db`select head_artifact_id,head_digest from allrice_development_heads where root_run_id=${f.rootRunId}`;
          return { artifactId: h!.head_artifact_id, digest: h!.head_digest };
        };
        const resultFor = async (label: string) =>
          waitFor(async () => {
            const [row] =
              await f.db`select r.payload from allrice_assistant_results r join allrice_assistant_instances i on i.run_id=r.run_id where i.root_run_id=${f.rootRunId} and i.label=${label}`;
            return row?.payload;
          });
        const command = (data: unknown) => ({
          nativeTool: {
            name: 'assistant_development',
            arguments: { command: JSON.stringify(data) },
          },
        });
        const report = (evidence: unknown[], summary: string) => ({
          nativeTool: {
            name: 'assistant_report',
            arguments: {
              status: 'completed',
              summary,
              evidence,
              incomplete: [],
              ...(evidence.length
                ? {}
                : { output: { name: 'test-result', content: summary } }),
            },
          },
        });
        const model = await p24Fixture(async (request) => {
          const text = JSON.stringify(request.messages);
          if (text.includes('ROOT_PRIVATE')) {
            switch (rootStep++) {
              case 0:
                return command({ action: 'initialize', seed });
              case 1:
                return {
                  nativeTool: {
                    name: 'assistant_delegate',
                    arguments: {
                      label: 'DEV_WRITER',
                      text: `DEV_WRITER: authorized baseline ${original}; propose exactly ${changed}`,
                      tools: ['assistant.development', 'assistant.report'],
                      development: JSON.stringify({
                        role: 'edit',
                        expectedHead: seed,
                        paths: ['test.mjs'],
                      }),
                    },
                  },
                };
              case 2: {
                expect(text).toContain('Published scoped proposal.');
                const report = await resultFor('DEV_WRITER');
                return command({
                  action: 'merge',
                  expectedHead: seed,
                  proposals: report.evidence.map(
                    (e: { id: string; digest: string }) => ({
                      artifactId: e.id,
                      digest: e.digest,
                    }),
                  ),
                });
              }
              case 3:
                return {
                  nativeTool: {
                    name: 'assistant_delegate',
                    arguments: {
                      label: 'DEV_TESTER',
                      text: 'DEV_TESTER: run the exact candidate in the approved sandbox and report actual results.',
                      tools: [
                        'assistant.development',
                        'assistant.report',
                        'local.process.execute',
                      ],
                      development: JSON.stringify({
                        role: 'test',
                        expectedHead: await currentHead(),
                      }),
                    },
                  },
                };
              case 4:
                expect(text).toContain(
                  'Exact candidate command completed; see authoritative receipt.',
                );
                await resultFor('DEV_TESTER');
                return {
                  nativeTool: {
                    name: 'assistant_delegate',
                    arguments: {
                      label: 'DEV_REVIEWER',
                      text: 'DEV_REVIEWER: inspect the exact candidate and actual test receipt, then issue your review.',
                      tools: ['assistant.development', 'assistant.report'],
                      development: JSON.stringify({
                        role: 'review',
                        expectedHead: await currentHead(),
                      }),
                    },
                  },
                };
              case 5: {
                expect(text).toContain('Independent review saved.');
                await resultFor('DEV_REVIEWER');
                if (mode === 'missing-delivery')
                  return {
                    text: 'NATIVE_DEVELOPMENT_DELIVERED: prose alone is not a verified delivery.',
                  };
                const [review] =
                  await f.db`select id from allrice_development_reviews where root_run_id=${f.rootRunId}`;
                return command({
                  action: 'deliver',
                  candidate: await currentHead(),
                  reviewId: review!.id,
                });
              }
              default:
                return {
                  text: 'NATIVE_DEVELOPMENT_DELIVERED: tested and independently reviewed; local directory unchanged.',
                };
            }
          }
          if (text.includes('DEV_WRITER')) {
            if (writerStep++ === 0) {
              const [a] =
                await f.db`select id from allrice_development_assignments where root_run_id=${f.rootRunId}`;
              return command({
                action: 'publish',
                assignmentId: a!.id,
                previous: null,
                proposal: {
                  files: [
                    { path: 'test.mjs', before: original, after: changed },
                  ],
                },
              });
            }
            const [p] =
              await f.db`select artifact_id,digest from allrice_development_proposals where root_run_id=${f.rootRunId}`;
            return report(
              [{ id: p!.artifact_id, digest: p!.digest }],
              'Published scoped proposal.',
            );
          }
          if (text.includes('DEV_TESTER')) {
            if (testerStep++ === 0) {
              const h = await currentHead();
              return {
                nativeTool: {
                  name: 'local_process_execute',
                  arguments: {
                    ...f.args,
                    files: [{ path: 'test.mjs', sha256: hash(original) }],
                    candidate: { artifactId: h.artifactId, checksum: h.digest },
                  },
                },
              };
            }
            return report(
              [],
              'Exact candidate command completed; see authoritative receipt.',
            );
          }
          if (text.includes('DEV_REVIEWER')) {
            if (reviewerStep++ === 0)
              return command({
                action: 'inspect',
                candidate: await currentHead(),
              });
            if (reviewerStep === 2) {
              const [op] =
                await f.db`select id from allrice_runtime_operations where root_run_id=${f.rootRunId}`;
              reviewerSawCode = text.includes('SAME_VERSION_VM_PASSED');
              reviewerSawTest =
                text.includes(op!.id) && text.includes('stdout');
              return command({
                action: 'review',
                candidate: await currentHead(),
                operationId: op!.id,
                verdict: 'accept',
                summary:
                  'Inspected exact diff and passing command; independent synthetic reviewer.',
              });
            }
            const [a] =
              await f.db`select a.artifact_id,a.digest from allrice_assistant_artifacts a join allrice_assistant_instances i on i.run_id=a.run_id where i.root_run_id=${f.rootRunId} and i.label='DEV_REVIEWER'`;
            return report(
              [{ id: a!.artifact_id, digest: a!.digest }],
              'Independent review saved.',
            );
          }
          throw Error('Unexpected synthetic model scope');
        });
        vi.stubEnv('ALLRICE_DSH_PLATFORM_HOME', join(model.root, 'platform'));
        await writeFile(join(model.root, 'test.mjs'), original);
        const adapter = new DshHarnessAdapter({
          runtimeRoot: join(model.root, 'runtime'),
          credentialResolver: {
            resolve: async () => ({ apiKey: 'synthetic-only' }),
          },
        });
        const abort = new AbortController();
        const runner =
          mode === 'vm'
            ? new LocalCommandRunner({
                socketPath: process.env.ALLRICE_LOCAL_DOCKER_TEST_SOCKET!,
                imageDigest: localCommandToolchainImageV1,
              })
            : null;
        let container: { attemptId: string; id: string } | undefined;
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
              systemInstructions: 'Only explicit bounded development tasks.',
              userRequest:
                'ROOT_PRIVATE: coordinate the specified development task.',
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
              database: f.db,
              storage,
              signal: abort.signal,
            }),
          });
          execution.catch(() => {});
          const operation = await waitFor(async () => {
            const [o] =
              await f.db`select id from allrice_runtime_operations where root_run_id=${f.rootRunId}`;
            return o;
          });
          await f.approve(
            await waitFor(() =>
              f.approvalFor(operation.id).catch(() => undefined),
            ),
          );
          const ledger = f.freshLedger(),
            lease = await ledger.dispatch({
              scope: f.task.scope,
              operationId: operation.id,
              leaseOwner: randomUUID(),
              leaseMs: 30000,
            });
          const cmd = RuntimeLocalCommandSchema.parse(lease.bridgePayload);
          const output = runner
            ? await runner.execute(model.root, cmd, {
                attemptId: lease.snapshot.binding.attempt.attemptId,
              })
            : {
                backend: 'local-vm-container-v1',
                containerId: 'a'.repeat(64),
                imageDigest: localCommandToolchainImageV1,
                stopped: true,
                exitCode: 0,
                reason: 'exited',
                stdout: 'synthetic receipt; VM not run',
                stderr: '',
                truncated: false,
                workCopy: 'local_isolated_copy',
                sourceDirectoryModified: false,
                candidate: localCommandCandidateEvidence(cmd),
              };
          if (runner)
            container = {
              attemptId: lease.snapshot.binding.attempt.attemptId,
              id: output.containerId,
            };
          expect(output.exitCode).toBe(0);
          if (runner) expect(output.stdout).toContain('SAME_VERSION_VM_PASSED');
          const identity = {
            scope: f.task.scope,
            operationId: operation.id,
            leaseToken: lease.leaseToken,
            attempt: lease.snapshot.binding.attempt,
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
                  digest: hash(JSON.stringify(output)),
                },
              },
            },
            evidence: { output },
          });
          // A real Bridge submits the terminal receipt, not a second usage
          // API call. Do not conceal missing production settlement in fixtures.
          const reservations =
            await f.db`select metric,settled_amount from allrice_runtime_reservations where operation_id=${operation.id}`;
          expect(reservations).toHaveLength(4);
          for (const r of reservations)
            expect(r.settled_amount).toBe(
              r.metric === 'tool_calls' ? '1' : '0',
            );
          await expect(execution).resolves.toMatchObject({
            answer: expect.stringContaining('NATIVE_DEVELOPMENT_DELIVERED'),
            assistantStatus:
              mode === 'missing-delivery' ? 'partial' : 'completed',
            usageComplete: true,
          });
          const tree = await f.runtime.getTree(f.requestContext, {
            runId: f.rootRunId,
          });
          expect(tree.results).toHaveLength(3);
          expect(reviewerSawCode).toBe(true);
          expect(reviewerSawTest).toBe(true);
          expect(
            tree.results.every(
              (r) => r.status === 'completed' && r.parentAdoptedSeq !== null,
            ),
          ).toBe(true);
          expect(await readFile(join(model.root, 'test.mjs'), 'utf8')).toBe(
            original,
          );
          const [delivery] =
            await f.db`select version_id from allrice_workbench_artifacts where run_id=${f.rootRunId} and request_id like 'development-deliver:%'`;
          if (mode === 'missing-delivery') expect(delivery).toBeUndefined();
          else expect(delivery).toBeDefined();
        } finally {
          abort.abort();
          await adapter.close();
          if (runner && container)
            await runner.cleanup(container.attemptId, container.id);
          await model.close();
        }
      },
      90000,
    );
  },
);
