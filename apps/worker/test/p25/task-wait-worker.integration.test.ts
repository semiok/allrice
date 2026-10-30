import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRuntimeFixtureDatabase } from '../../../../packages/database/src/runtime.fixture.ts';
import { createLocalCommandFixture } from '../../../../packages/database/src/local-command.fixture.ts';
import * as client from '../../../../packages/database/src/core/client.ts';
import { resolveTaskRuntimePolicy } from '../../../../packages/database/src/task-runtime-policy.ts';
import { readTaskClock } from '../../../../packages/database/src/task-clock.ts';
import {
  maintainQueue,
  enqueueRun,
} from '../../../../packages/database/src/execution/queue.ts';
import { p24Fixture, gate, latestTaskMessage } from '../p24/fixture.js';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET153 separate Worker process recovery with actual native DSH', () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  beforeAll(async () => {
    for (const flag of [
      'ALLRICE_ASSISTANTS_ENABLED',
      'ALLRICE_LOCAL_COMMAND_ENABLED',
      'ALLRICE_RUNTIME_POLICY_ENABLED',
      'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
    ])
      vi.stubEnv(flag, '1');
    fixture = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fixture?.close();
  });
  it.each(['parked', 'child-settles', 'active'] as const)(
    'kills a %s Worker and preserves the Run without replaying an uncertain dispatch',
    async (phase) => {
      const pending = gate();
      const nativeChildren = phase === 'child-settles';
      let rootCalls = 0;
      const model = await p24Fixture(async (request) => {
        if (phase === 'active') {
          await pending.promise;
          return { text: 'Late output' };
        }
        if (nativeChildren) {
          const task = latestTaskMessage(request);
          if (
            task?.role === 'user' &&
            JSON.stringify(task.content).includes('CHILD_STILL_WORKING')
          ) {
            await pending.promise;
            return { text: 'Child finished naturally.' };
          }
          if (++rootCalls === 1)
            return {
              nativeTool: {
                name: 'subagent',
                arguments: {
                  description: '继续核对',
                  prompt: 'CHILD_STILL_WORKING',
                },
              },
            };
        } else rootCalls++;
        if (nativeChildren && rootCalls > 2)
          expect(JSON.stringify(request.messages)).toContain(
            'Child finished naturally.',
          );
        return rootCalls === (nativeChildren ? 2 : 1)
          ? {
              nativeTool: {
                name: 'ask_user_question',
                arguments: {
                  questions: [
                    {
                      id: 'choice',
                      question: 'Continue?',
                      options: [{ label: 'Continue' }],
                    },
                  ],
                },
              },
            }
          : { text: 'Same Run recovered successfully.' };
      });
      const children: ChildProcess[] = [];
      const f = await createLocalCommandFixture(fixture.db, 'ask', false, {
        deferRuntimeRoot: true,
      });
      f.requestContext.memberships = f.context.policySnapshot.memberships;
      const [scope] = await f.db<
        { schema: string }[]
      >`select current_schema() as schema`;
      const databaseUrl = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
      databaseUrl.searchParams.set(
        'options',
        `-csearch_path=${scope!.schema},public`,
      );
      const [runtime] =
        await f.db`select config_checksum from allrice_conversation_runtimes where session_id=${f.session}`;
      const configFile = join(model.root, 'worker.json');
      await writeFile(
        configFile,
        JSON.stringify({
          org: f.org,
          workspace: f.workspace,
          user: f.user,
          session: f.session,
          assignment: f.assignment,
          version: f.version,
          configChecksum: runtime!.config_checksum,
          root: model.root,
          baseUrl: model.baseUrl,
          nativeChildren,
        }),
        { mode: 0o600 },
      );
      await f.db`insert into allrice_task_clocks(run_id,organization_id,workspace_id,policy) values(${f.rootRunId},${f.org},${f.workspace},${f.db.json({ ...resolveTaskRuntimePolicy([]) })})`;
      await f.db`update allrice_jobs set status='queued',worker_id=null,lease_token=null,lease_expires_at=null,claimed_at=null,heartbeat_at=null,available_at=clock_timestamp() where id=${f.worker.jobId}`;
      await f.db`update allrice_runs set state='queued' where id=${f.rootRunId}`;
      function launch() {
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            resolve(import.meta.dirname, 'task-wait-worker.fixture.ts'),
            configFile,
          ],
          {
            cwd: resolve(import.meta.dirname, '../../../..'),
            env: {
              ...process.env,
              DATABASE_URL: databaseUrl.toString(),
              TSX_TSCONFIG_PATH: resolve(
                import.meta.dirname,
                '../../../../tsconfig.base.json',
              ),
              ALLRICE_NATIVE_WAIT_FIXTURE: 'synthetic-only',
              ALLRICE_DSH_PLATFORM_HOME: join(model.root, 'platform'),
            },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          },
        );
        children.push(child);
        let log = '';
        child.stdout!.on('data', (b) => {
          log = (log + String(b)).slice(-5000);
        });
        child.stderr!.on('data', (b) => {
          log = (log + String(b)).slice(-5000);
        });
        let report: Record<string, unknown> | undefined;
        let questionAt: number | undefined;
        child.on('message', (value) => {
          const message = value as Record<string, unknown>;
          if (typeof message.questionAt === 'number')
            questionAt = message.questionAt;
          if (message.finished) report = message;
        });
        return {
          child,
          report: () => report,
          questionAt: () => questionAt,
          log: () => log,
        };
      }
      async function kill(child: ChildProcess) {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const closed = once(child, 'close');
        child.kill('SIGKILL');
        await closed;
      }
      try {
        const first = launch();
        await expect
          .poll(
            () => ({
              calls: model.requests.length > 0,
              exit: first.child.exitCode,
              log: first.child.exitCode === null ? '' : first.log(),
            }),
            { timeout: 20000 },
          )
          .toMatchObject({ calls: true, exit: null });
        if (phase !== 'active') {
          if (nativeChildren) {
            await expect
              .poll(first.questionAt, { timeout: 20000 })
              .toBeTruthy();
            // Real Worker timer and real Host: child spans both the 30s grace
            // period and the former extra 15s park RPC timeout. No fake clocks.
            await delay(31_000);
            const [live] =
              await f.db`select status,attempt,lease_token from allrice_jobs where id=${f.worker.jobId}`;
            expect(live).toMatchObject({ status: 'running', attempt: 1 });
            expect(live!.lease_token).toBeTruthy();
            expect(
              await f.db`select 1 from allrice_native_question_waits where run_id=${f.rootRunId}`,
            ).toHaveLength(0);
            await delay(16_000);
            expect(first.report()).toBeUndefined();
            expect(model.abortedRequests).toEqual([]);
            expect(model.requests).toHaveLength(3);
            pending.release();
          }
          await expect
            .poll(first.report, { timeout: 40000 })
            .toMatchObject({ finished: true, processes: 0 });
          const [wait] =
            await f.db`select checkpoint,generation from allrice_native_question_waits where run_id=${f.rootRunId} and state='parked'`;
          expect(wait).toBeTruthy();
          const [parkedJob] =
            await f.db`select id,run_id,attempt,status,worker_id,lease_token from allrice_jobs where id=${f.worker.jobId}`;
          expect(parkedJob).toMatchObject({
            id: f.worker.jobId,
            run_id: f.rootRunId,
            attempt: 1,
            status: 'waiting_approval',
            worker_id: null,
            lease_token: null,
          });
          if (nativeChildren) {
            expect(Date.now() - first.questionAt()!).toBeGreaterThanOrEqual(
              47_000,
            );
            expect(first.report()?.nativeDelivery).toEqual({
              calls: 3,
              complete: true,
            });
            const facts = first.report()?.nativeFacts as {
              phase: string;
              outcome?: string;
              nativeSessionId: string;
            }[];
            expect(facts.filter((fact) => fact.phase === 'start')).toHaveLength(
              3,
            );
            expect(
              facts.filter(
                (fact) =>
                  fact.phase === 'finish' && fact.outcome === 'succeeded',
              ),
            ).toHaveLength(3);
            expect(
              new Set(facts.map((fact) => fact.nativeSessionId)).size,
            ).toBe(2);
          }
          expect(first.report()?.questionSuspension).toBe(true);
          const before = await f.db.begin((tx) =>
            readTaskClock(tx, f.rootRunId),
          );
          expect(before!.phase).toBe('waiting');
          await kill(first.child);
          await f.db`update allrice_task_clocks set changed_at=clock_timestamp()-interval '40 minutes' where run_id=${f.rootRunId}`;
          const userMessage = randomUUID(),
            assistantMessage = randomUUID();
          await f.db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
          values(${userMessage},${f.org},${f.workspace},${f.session},${f.user},'user','{}'),(${assistantMessage},${f.org},${f.workspace},${f.session},${f.user},'assistant','{}')`;
          await enqueueRun(
            f.requestContext,
            {
              workspaceId: f.workspace,
              type: 'allrice.employee.run',
              input: {},
              idempotencyKey: randomUUID(),
              timeoutMs: 3600000,
            },
            {
              conversationDelivery: {
                sessionId: f.session,
                userMessageId: userMessage,
                assistantMessageId: assistantMessage,
                clientUserMessageId: randomUUID(),
                requestedMode: 'steer',
                expectedTurnId: wait!.checkpoint.turnId,
                expectedGeneration: wait!.generation,
                hasAttachments: false,
                message: `allrice:user-question:v1:${JSON.stringify({ questionId: wait!.checkpoint.questionId, answers: [{ id: 'choice', selected: ['Continue'] }] })}`,
              },
            },
          );
          await maintainQueue();
          await maintainQueue();
          const second = launch();
          await expect
            .poll(() => second.report() ?? { log: second.log() }, {
              timeout: 20000,
            })
            .toMatchObject({ finished: true });
          const [run] =
            await f.db`select state,result from allrice_runs where id=${f.rootRunId}`;
          expect(run).toMatchObject({
            state: 'succeeded',
            result: { answer: 'Same Run recovered successfully.' },
          });
          const after = await f.db.begin((tx) =>
            readTaskClock(tx, f.rootRunId),
          );
          expect(after!.waitingMs).toBeGreaterThanOrEqual(2400000);
          expect(after!.activeMs).toBeGreaterThanOrEqual(before!.activeMs);
          expect(model.requests).toHaveLength(nativeChildren ? 4 : 2);
          const [completedJob] =
            await f.db`select id,run_id,attempt,status from allrice_jobs where id=${f.worker.jobId}`;
          expect(completedJob).toMatchObject({
            id: f.worker.jobId,
            run_id: f.rootRunId,
            attempt: 2,
            status: 'succeeded',
          });
          const [command] =
            await f.db`select state,native_proof from allrice_conversation_commands where session_id=${f.session}`;
          expect(command).toMatchObject({
            state: 'consumed',
            native_proof: { status: 'adopted' },
          });
        } else {
          await kill(first.child);
          pending.release();
          await f.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
          await maintainQueue();
          await maintainQueue();
          const second = launch();
          await expect
            .poll(() => second.report() ?? { log: second.log() }, {
              timeout: 20000,
            })
            .toMatchObject({ finished: true });
          const [run] =
            await f.db`select state,error_code from allrice_runs where id=${f.rootRunId}`;
          expect(run).toMatchObject({
            state: 'failed',
            error_code: 'DSH_EXECUTION_OUTCOME_UNKNOWN',
          });
          expect(model.requests).toHaveLength(1);
        }
      } finally {
        pending.release();
        await Promise.all(children.map(kill));
        await model.close();
      }
    },
    120000,
  );
});
