import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAssistantFixtureDatabase } from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import { createAssistantLocalCommandFixture } from '../../../../packages/database/src/local-command-assistant.fixture.ts';
import * as client from '../../../../packages/database/src/core/client.ts';
import { resolveTaskRuntimePolicy } from '../../../../packages/database/src/task-runtime-policy.ts';
import { readTaskClock } from '../../../../packages/database/src/task-clock.ts';
import {
  maintainQueue,
  enqueueRun,
} from '../../../../packages/database/src/execution/queue.ts';
import { p24Fixture, gate } from '../p24/fixture.js';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET153 separate Worker process recovery with actual native DSH', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    for (const flag of [
      'ALLRICE_ASSISTANTS_ENABLED',
      'ALLRICE_LOCAL_COMMAND_ENABLED',
      'ALLRICE_RUNTIME_POLICY_ENABLED',
      'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
    ])
      vi.stubEnv(flag, '1');
    fixture = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fixture?.close();
  });
  it.each(['parked', 'active'] as const)(
    'kills a %s Worker and preserves the Run without replaying an uncertain dispatch',
    async (phase) => {
      const pending = gate();
      const model = await p24Fixture(async (_request, index) => {
        if (phase === 'active') {
          await pending.promise;
          return { text: 'Late output' };
        }
        return index === 1
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
      const f = await createAssistantLocalCommandFixture(
        fixture.db,
        'ask',
        false,
        { deferRuntimeRoot: true, skipChild: true },
      );
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
        child.on('message', (value) => {
          report = value as Record<string, unknown>;
        });
        return { child, report: () => report, log: () => log };
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
              calls: model.requests.length,
              exit: first.child.exitCode,
              log: first.child.exitCode === null ? '' : first.log(),
            }),
            { timeout: 20000 },
          )
          .toMatchObject({ calls: 1, exit: null });
        if (phase === 'parked') {
          await expect
            .poll(first.report, { timeout: 40000 })
            .toMatchObject({ finished: true, processes: 0 });
          const [wait] =
            await f.db`select checkpoint,generation from allrice_native_question_waits where run_id=${f.rootRunId} and state='parked'`;
          expect(wait).toBeTruthy();
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
          expect(model.requests).toHaveLength(2);
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
    90000,
  );
});
