import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { createLocalCommandFixture } from './local-command.fixture.ts';
import * as client from './core/client.ts';
import { bindNativeQuestionFixture } from './native-question-binding.fixture.ts';
import { createSession, authenticateSession } from './identity.ts';
import {
  appendJobEvent,
  cancelRun,
  claimNextJob,
  completeJob,
  startClaimedJob,
} from './execution/queue.ts';
import { createExperienceFixture } from './experience.fixture.ts';
import { createChatSession, sendChatMessage } from './workspace/service.ts';
import { getSessionRunTimings } from './conversation/interaction-status.ts';
import { createTaskProgressRuntime } from './task-progress.ts';
import { createRuntimeOperationLedger } from './runtime-ledger/ledger.ts';
import { projectCurrentTaskClock, readTaskClock } from './task-clock.ts';
import { resolveTaskRuntimePolicy } from './task-runtime-policy.ts';
import {
  acquireConversationRuntime,
  bindConversationThread,
  recordConversationTurn,
} from './conversation/conversation-runtime.ts';
import {
  closeNativeRunQuestions,
  nativeQuestionAnswerAdopted,
  requireNativeQuestionAdmission,
  readNativeQuestion,
  readNativeQuestionMode,
  updateNativeQuestionMode,
  type NativeQuestionProjection,
} from './native-questions.ts';

// The HTTP handler and every database write are real. Only the browser login
// lookup is supplied by the isolated fixture; no real cookie/credential reads.
const webIdentity = vi.hoisted(() => ({
  getRequestContext: vi.fn(),
}));
vi.mock('../../../apps/web/lib/identity/session.ts', () => webIdentity);

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'MET-210 session question projection through the leased Worker event entry',
  () => {
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
    async function setup() {
      const f = await createLocalCommandFixture(fixture.db, 'ask', false, {});
      await f.db`insert into allrice_task_clocks(run_id,organization_id,workspace_id,policy)
      values(${f.rootRunId},${f.org},${f.workspace},${f.db.json({ ...resolveTaskRuntimePolicy([]) })})`;
      const [user] =
        await f.db`select email from allrice_users where id=${f.user}`;
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', user!.email);
      const login = await createSession(f.user);
      const adminContext = (await authenticateSession(login.token, {
        organizationId: f.org,
        workspaceId: f.workspace,
      }))!;
      const nativeSessionId = `dsh-${f.session}`;
      await bindNativeQuestionFixture(f.db, f.rootRunId, nativeSessionId);
      const question = {
        callId: 'call:1',
        state: 'open',
        questions: [
          { id: 'q', question: '继续？', options: [{ label: '继续' }] },
        ],
      };
      const send = (
        sequence: number,
        active = [question],
        settled: unknown[] = [],
        sessionId = nativeSessionId,
        leaseToken = f.worker.leaseToken,
      ) =>
        appendJobEvent({
          ...f.worker,
          leaseToken,
          type: 'harness.native',
          payload: {
            source: 'dsh',
            sourceEventType: 'session/user-questions',
            nativePayload: {
              sessionId,
              sequence,
              questions: { active, settled },
            },
          },
        });
      const read = () =>
        f.db.begin((tx) =>
          readNativeQuestion(tx, f.session, `${nativeSessionId}:call:1`),
        );
      return { ...f, send, read, question, nativeSessionId, adminContext };
    }
    it('defaults to legacy; only a platform administrator can select timed', async () => {
      const f = await setup();
      expect(await readNativeQuestionMode()).toBe('legacy');
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', 'other@example.test');
      await expect(
        updateNativeQuestionMode(f.adminContext, 'timed'),
      ).rejects.toThrow();
      expect(await readNativeQuestionMode()).toBe('legacy');
    });
    it('mirrors open/continued/settled, keeps question text, rejects stale snapshots and scopes identities', async () => {
      const f = await setup();
      await updateNativeQuestionMode(f.adminContext, 'timed');
      await f.send(10);
      expect((await f.read())?.state).toBe('open');
      expect(
        (await f.db.begin((tx) => readTaskClock(tx, f.rootRunId)))?.phase,
      ).toBe('waiting');
      expect(
        await f.db`select * from allrice_task_questions where run_id=${f.rootRunId}`,
      ).toHaveLength(0);
      await f.db`update allrice_task_clocks set active_ms=60000,changed_at=clock_timestamp()-interval '31 minutes' where run_id=${f.rootRunId}`;
      const waiting = await f.db.begin((tx) => readTaskClock(tx, f.rootRunId));
      expect(waiting!.activeMs).toBe(60000);
      expect(waiting!.waitingMs).toBeGreaterThanOrEqual(31 * 60_000);
      expect(waiting!.deadlineAt.getTime()).toBeGreaterThan(
        Date.now() + 31 * 60_000,
      );
      await f.send(11, [{ ...f.question, state: 'continued' }]);
      expect((await f.read())?.state).toBe('continued');
      const answers = [{ id: 'q', selected: [] }];
      await f.send(12, [], [{ callId: 'call:1', answers }]);
      expect(await f.read()).toMatchObject({
        state: 'settled',
        questions: f.question.questions,
        answers,
      });
      await f.send(10);
      expect((await f.read())?.state).toBe('settled');
      const other = await setup();
      await other.send(99, [other.question], [], f.nativeSessionId);
      expect(await other.read()).toBeNull();
      await expect(
        f.send(13, [], [], f.nativeSessionId, randomUUID()),
      ).rejects.toThrow();
      expect((await f.read())?.state).toBe('settled');
    });
    it('PR4 generation admission rejects revoked and unbound cards without legacy fallback', async () => {
      const f = await setup();
      await updateNativeQuestionMode(f.adminContext, 'timed');
      const nativeId = `dsh-${f.session}-${randomUUID()}`;
      await bindNativeQuestionFixture(f.db, f.rootRunId, nativeId);
      await f.send(1, [f.question], [], nativeId);
      const admit = (id = `${nativeId}:call:1`) =>
        f.db.begin((tx) => requireNativeQuestionAdmission(tx, f.session, id));
      await expect(admit()).resolves.toBeUndefined();
      await expect(admit(`${nativeId}:missing`)).rejects.toMatchObject({
        code: 'question_expired',
      });
      await f.db`delete from allrice_native_session_bindings where native_session_id=${nativeId}`;
      await expect(admit()).rejects.toMatchObject({ code: 'question_expired' });
      await bindNativeQuestionFixture(f.db, f.rootRunId, nativeId);
      await updateNativeQuestionMode(f.adminContext, 'legacy');
      await expect(admit()).rejects.toMatchObject({ code: 'question_expired' });
      await updateNativeQuestionMode(f.adminContext, 'timed');
      await expect(admit()).rejects.toMatchObject({ code: 'question_expired' });
    });
    it('rollback revokes active calls across later snapshots and re-enable; stop closes only its source Run', async () => {
      const f = await setup();
      await updateNativeQuestionMode(f.adminContext, 'timed');
      await f.send(1);
      await updateNativeQuestionMode(f.adminContext, 'legacy');
      expect((await f.read())?.closed_at).toBeInstanceOf(Date);
      await f.send(2);
      await updateNativeQuestionMode(f.adminContext, 'timed');
      await f.send(3);
      expect((await f.read())?.closed_at).toBeInstanceOf(Date);
      const other = await setup();
      await other.send(1);
      await f.db.begin((tx) => closeNativeRunQuestions(tx, f.rootRunId));
      expect((await other.read())?.closed_at).toBeNull();
      await other.db.begin((tx) =>
        closeNativeRunQuestions(tx, other.rootRunId),
      );
      expect((await other.read())?.closed_at).toBeInstanceOf(Date);
      expect((await other.read())?.state).toBe('open');
    });
    it('binds both adoption proofs to the native settled answers and revocation fence', async () => {
      const f = await setup();
      await updateNativeQuestionMode(f.adminContext, 'timed');
      const questionId = `${f.nativeSessionId}:call:1`;
      const answers = [{ id: 'q', selected: ['继续'] }];
      const proof = {
        status: 'adopted',
        inputId: randomUUID(),
        messageId: questionId,
        sequence: 3,
        turnId: 'later:turn:2',
        checkpoint: 'question_replied',
        callId: 'call:1',
      };
      const verify = (patch = {}, batch = answers) =>
        f.db.begin((tx) =>
          nativeQuestionAnswerAdopted(
            tx,
            f.session,
            questionId,
            { ...proof, ...patch },
            { questionId, answers: batch },
          ),
        );
      await f.send(1);
      expect(await verify()).toBe(false);
      await f.send(4, [], [{ callId: 'call:1', answers }]);
      expect(await verify()).toBe(true);
      const other = await setup();
      expect(
        await f.db.begin((tx) =>
          nativeQuestionAnswerAdopted(tx, other.session, questionId, proof, {
            questionId,
            answers,
          }),
        ),
      ).toBe(false);
      expect(await verify({ checkpoint: 'question_resolved' })).toBe(true);
      for (const patch of [
        { callId: 'other' },
        { messageId: `other:${questionId}` },
        { checkpoint: 'step_user_message' },
        { sequence: 5 },
        { status: 'pending' },
      ])
        expect(await verify(patch)).toBe(false);
      expect(await verify({}, [{ id: 'q', selected: [] }])).toBe(false);
      await updateNativeQuestionMode(other.adminContext, 'legacy');
      expect(await verify()).toBe(false);
      await expect(
        f.db.begin((tx) =>
          requireNativeQuestionAdmission(tx, f.session, questionId),
        ),
      ).rejects.toMatchObject({ code: 'question_expired' });
      await updateNativeQuestionMode(other.adminContext, 'timed');
      await f.db.begin((tx) =>
        requireNativeQuestionAdmission(tx, f.session, 'question-program'),
      );
      await expect(
        f.db.begin((tx) =>
          requireNativeQuestionAdmission(
            tx,
            f.session,
            `${f.nativeSessionId}:missing`,
          ),
        ),
      ).rejects.toMatchObject({ code: 'question_expired' });
    });
    it('copies DSH removal rather than inventing a settled answer and preserves archived sessions', async () => {
      const f = await setup();
      await updateNativeQuestionMode(f.adminContext, 'timed');
      await f.send(1);
      await f.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${f.session}`;
      expect((await f.read())?.closed_at).toBeNull();
      await f.send(2, []);
      expect(await f.read()).toBeNull();
      await f.send(1);
      expect(await f.read()).toBeNull();
    });
  },
);

// Independent PR4a coverage: native snapshots stand in for the model/Host;
// chat admission, Worker lease checks, clocks and cancellation use real SQL.
// No claim is made about PR4b/4c answer routing or enabling timed in the UI.
suite('MET-210 PR4a chat boundaries and populated-schema upgrade', () => {
  let isolated: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  type Conversation = Awaited<ReturnType<typeof createExperienceFixture>>;
  type Turn = Awaited<ReturnType<typeof startTurn>>;
  type Active = NativeQuestionProjection['questions']['active'];
  type Settled = NativeQuestionProjection['questions']['settled'];

  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Error('PR4a SQL tests must not access external services'),
    );
    isolated = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(isolated.db);
  }, 120000);
  afterAll(async () => {
    try {
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await isolated?.close();
    }
  });

  async function startTurn(
    f: Conversation,
    text = '请帮我整理本周计划，需要决定的地方先问我。',
    sessionId = f.session.id,
  ) {
    const sent = await sendChatMessage(f.owner, f.workspace, sessionId, {
      clientMessageId: randomUUID(),
      text,
      deliveryMode: 'follow_up',
    });
    const workerId = randomUUID();
    const job = await claimNextJob(workerId, 120000);
    expect(job?.id).toBe(sent.run.job.id);
    const leaseToken = job!.lease!.token;
    const execution = await startClaimedJob(workerId, job!.id, leaseToken);
    expect(execution).not.toBeNull();
    await bindNativeQuestionFixture(isolated.db, sent.run.id);
    return {
      runId: sent.run.id,
      sessionId,
      nativeSessionId: `dsh-${sessionId}`,
      workerId,
      jobId: job!.id,
      leaseToken,
      progress: createTaskProgressRuntime(
        {
          context: execution!.context,
          worker: { jobId: job!.id, workerId, leaseToken },
        },
        isolated.db,
      ),
    };
  }
  const question = (
    callId: string,
    text = '要先做哪一项？',
  ): Active[number] => ({
    callId,
    state: 'open',
    questions: [
      {
        id: 'priority',
        question: text,
        options: [{ label: '方案 A' }],
        multiSelect: false,
      },
    ],
  });
  const sendView = (
    turn: Turn,
    sequence: number,
    active: Active,
    settled: Settled = [],
    sessionId = turn.nativeSessionId,
  ) =>
    appendJobEvent({
      ...turn,
      type: 'harness.native',
      payload: {
        source: 'dsh',
        sourceEventType: 'session/user-questions',
        nativePayload: { sessionId, sequence, questions: { active, settled } },
      },
    });
  const sendNotice = (
    turn: Turn,
    questionId: string,
    answered = false,
    durable = false,
  ) =>
    appendJobEvent({
      ...turn,
      type: 'harness.native',
      payload: {
        source: 'dsh',
        sourceEventType: answered
          ? 'session/user-question-answered'
          : 'session/user-question',
        nativePayload: { sessionId: turn.nativeSessionId, questionId, durable },
      },
    });
  const rows = (sessionId: string) => isolated.db`
    select * from allrice_native_questions where session_id=${sessionId} order by call_id`;
  const clockRows = (runId: string) => isolated.db`
    select * from allrice_task_clocks where run_id=${runId}`;
  const phase = async (
    f: Conversation,
    runId: string,
    sessionId = f.session.id,
  ) =>
    (await getSessionRunTimings(f.owner, sessionId)).runTimings.find(
      (row) => row.runId === runId,
    )?.timing.phase;

  async function holdLock(take: (tx: TransactionSql) => Promise<unknown>) {
    let release!: () => void;
    let ready!: (pid: number) => void;
    let failed!: (error: unknown) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = new Promise<number>((resolve, reject) => {
      ready = resolve;
      failed = reject;
    });
    const done = isolated.db.begin(async (tx) => {
      await take(tx);
      const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() pid`;
      ready(row!.pid);
      await gate;
    });
    void done.catch(failed);
    return { pid: await held, release, done };
  }

  // Observe the actual PostgreSQL wait graph, never infer order from elapsed
  // time or a single successful Promise.all race.
  async function waitingOn(pid: number, query: string) {
    let matches: { pid: number }[] = [];
    await expect
      .poll(
        async () => {
          matches = await isolated.db<{ pid: number }[]>`
        select pid from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid))
          and query like ${`%${query}%`} and wait_event_type='Lock'`;
          return matches.length;
        },
        { timeout: 2000, interval: 10 },
      )
      .toBe(1);
    return matches[0]!.pid;
  }

  it.each(['commit', 'abort'] as const)(
    'PR4 rollback changes every live session Run and budget in one transaction: %s',
    async (outcome) => {
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', `sha256:${'a'.repeat(64)}`);
      const f = await createExperienceFixture(isolated.db);
      await updateNativeQuestionMode(f.reviewer, 'timed');
      const terminal = await startTurn(f);
      const old = {
        ...question('from-finished-run'),
        state: 'continued' as const,
      };
      await sendView(terminal, 1, [old]);
      await completeJob({
        ...terminal,
        result: { text: '本轮结束，仍可补答' },
      });
      const a = await startTurn(f);
      // The public chat queue serializes Runs of one Session. Its next queued
      // Run is still in rollback's live set and must receive a refreshed clock.
      const queued = await sendChatMessage(f.owner, f.workspace, f.session.id, {
        text: '下一轮继续整理',
        clientMessageId: randomUUID(),
        deliveryMode: 'follow_up',
      });
      const b = { runId: queued.run.id, sessionId: f.session.id };
      const separate = async (title: string) => {
        const session = await createChatSession(f.owner, {
          workspaceId: f.workspace,
          title,
        });
        return startTurn(f, title, session.id);
      };
      const quiet = await separate('没有问题的会话');
      const native = await separate('另一个有原生题的会话');
      await sendView(native, 1, [question('another-native')]);
      const legacy = await separate('只有程序题的会话');
      await sendNotice(legacy, 'program-progress');
      const mixed = await separate('原生题和程序题都未答');
      await sendView(mixed, 1, [question('native-with-program')]);
      await sendNotice(mixed, 'program-progress');
      const turns = [terminal, a, b, quiet, native, legacy, mixed];
      const ids = turns.map((t) => t.runId);
      // Chat-only Runs need not have an operation root. Register real roots
      // for these two so both root and Job budget projections are exercised.
      const ledger = createRuntimeOperationLedger({
        database: isolated.db,
        admission: async () => {},
      });
      for (const t of [a, native]) {
        const clock = await isolated.db.begin((tx) =>
          readTaskClock(tx, t.runId),
        );
        await ledger.createRoot({
          task: {
            scope: {
              organizationId: f.org,
              workspaceId: f.workspace,
              projectId: null,
            },
            runId: t.runId,
            rootRunId: t.runId,
            parentRunId: null,
            chatSessionId: t.sessionId,
            frozenConfiguration: {
              employeeVersionId: null,
              digest: `sha256:${'a'.repeat(64)}`,
            },
          },
          deadlineAt: clock!.deadlineAt.toISOString(),
          budgets: [
            {
              metric: 'model_calls',
              unit: 'calls',
              currency: null,
              capacity: 10,
              source: { kind: 'worker', sourceId: 'pr4-isolated-budget' },
            },
          ],
        });
      }
      // Simulated elapsed waiting, without wall-clock sleeps or changing the
      // frozen policy. The rollback must preserve already charged active time.
      await isolated.db`update allrice_task_clocks set active_ms=25000,
        changed_at=clock_timestamp()-interval '2 minutes' where run_id in (${a.runId},${native.runId})`;
      const snapshot = async () => ({
        mode: await readNativeQuestionMode(),
        clocks:
          await isolated.db`select c.*,r.deadline_at,j.timeout_at from allrice_task_clocks c
          left join allrice_runtime_roots r on r.root_run_id=c.run_id
          join allrice_jobs j on j.run_id=c.run_id where c.run_id in ${isolated.db(ids)} order by c.run_id`,
        questions: await isolated.db`select * from allrice_native_questions
          where session_id in (${f.session.id},${mixed.sessionId},${native.sessionId}) order by session_id,call_id`,
        program:
          await isolated.db`select * from allrice_task_questions where run_id in ${isolated.db(ids)} order by run_id,question_id`,
        events:
          await isolated.db`select * from allrice_task_clock_events where run_id in ${isolated.db(ids)} order by run_id,occurred_at`,
      });
      const before = await snapshot();
      expect(before.clocks).toHaveLength(turns.length);
      for (const t of [a, native, mixed, legacy])
        expect(before.clocks.find((c) => c.run_id === t.runId)?.phase).toBe(
          'waiting',
        );
      const key = randomUUID();
      // A deferred trigger parks the REAL transaction at COMMIT, after all
      // revocations and both clock passes. Other connections must see only the
      // old complete state; an injected commit failure must roll everything back.
      await isolated.db
        .unsafe(`create function pr4_mode_commit_barrier() returns trigger language plpgsql as $$
        begin
          perform set_config('lock_timeout','5s',true);
          perform pg_advisory_xact_lock(hashtextextended(tg_argv[0],0));
          if tg_argv[1]='abort' then raise exception 'pr4 injected commit failure'; end if;
          return new;
        end $$;
        create constraint trigger pr4_mode_commit_barrier after update on allrice_settings
          deferrable initially deferred for each row
          when (new.key='native_question_mode' and new.value='"legacy"'::jsonb)
          execute function pr4_mode_commit_barrier('${key}','${outcome}')`);
      const gate = await holdLock(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${key},0))`;
      });
      const rollback = updateNativeQuestionMode(f.reviewer, 'legacy');
      void rollback.catch(() => {});
      try {
        await waitingOn(gate.pid, 'commit');
        expect(await snapshot()).toEqual(before);
        gate.release();
        await gate.done;
        if (outcome === 'abort') {
          await expect(rollback).rejects.toThrow('pr4 injected commit failure');
          expect(await snapshot()).toEqual(before);
        } else {
          await expect(rollback).resolves.toBe('legacy');
          const after = await snapshot();
          expect(after.mode).toBe('legacy');
          expect(after.questions).toHaveLength(3);
          expect(
            after.questions.every((q) => q.closed_at instanceof Date),
          ).toBe(true);
          expect(after.program).toEqual(before.program);
          for (const t of [terminal, quiet, legacy])
            expect(after.clocks.find((c) => c.run_id === t.runId)).toEqual(
              before.clocks.find((c) => c.run_id === t.runId),
            );
          expect(
            after.clocks.find((c) => c.run_id === mixed.runId)?.phase,
          ).toBe('waiting');
          expect(after.clocks.find((c) => c.run_id === b.runId)?.phase).toBe(
            'queued',
          );
          expect(
            after.clocks.find((c) => c.run_id === b.runId)?.changed_at,
          ).not.toEqual(
            before.clocks.find((c) => c.run_id === b.runId)?.changed_at,
          );
          for (const t of [a, native]) {
            const c = after.clocks.find((c) => c.run_id === t.runId)!;
            expect(c.phase).toBe('active');
            expect(c.active_ms).toBe(25000);
            expect(c.waiting_ms).toBeGreaterThanOrEqual(120000);
            const deadline = new Date(
              c.changed_at.getTime() + c.policy.timeoutMs - c.active_ms,
            );
            expect(c.timeout_at).toEqual(deadline);
            expect(c.deadline_at).toEqual(deadline);
          }
          await updateNativeQuestionMode(f.reviewer, 'timed');
          await sendView(a, 2, [old]);
          expect((await rows(f.session.id))[0]?.closed_at).toEqual(
            after.questions.find((q) => q.session_id === f.session.id)
              ?.closed_at,
          );
          expect(await phase(f, a.runId)).toBe('active');
          expect(await phase(f, b.runId)).toBe('queued');
        }
      } finally {
        gate.release();
        await gate.done;
        await Promise.allSettled([rollback]);
        await isolated.db.unsafe(
          'drop trigger pr4_mode_commit_barrier on allrice_settings; drop function pr4_mode_commit_barrier()',
        );
      }
    },
    30000,
  );

  it.each(['append-first', 'answer-first', 'rollback-first'] as const)(
    'PR4 mode fence serializes the real input/event entry: %s',
    async (order) => {
      const f = await createExperienceFixture(isolated.db);
      await updateNativeQuestionMode(f.reviewer, 'timed');
      const turn = await startTurn(f);
      const current = question('fenced-input');
      await sendView(turn, 1, [current]);
      const runtime = {
        organizationId: f.org,
        workspaceId: f.workspace,
        sessionId: f.session.id,
        ownerId: f.owner.actor.id,
        runId: turn.runId,
        workerId: turn.workerId,
      };
      await acquireConversationRuntime({
        ...runtime,
        configChecksum: `sha256:${'a'.repeat(64)}`,
        compactThresholdTokens: 10000,
      });
      await bindConversationThread({
        ...runtime,
        threadId: turn.nativeSessionId,
      });
      const turnId = `${turn.nativeSessionId}:turn:1`;
      const binding = await recordConversationTurn({
        ...runtime,
        threadId: turn.nativeSessionId,
        turnId,
      });
      const clientMessageId = randomUUID();
      const answer = () =>
        sendChatMessage(f.owner, f.workspace, f.session.id, {
          text: '方案 A',
          clientMessageId,
          deliveryMode: 'steer',
          expectedTurnId: turnId,
          expectedGeneration: binding.generation,
          userQuestionAnswer: {
            questionId: `${turn.nativeSessionId}:${current.callId}`,
            answers: [{ id: 'priority', selected: ['方案 A'] }],
          },
        });
      const gate = await holdLock(async (tx) => {
        if (order === 'rollback-first')
          await tx`select id from allrice_settings where key='native_question_mode' and scope_type='system' and scope_id is null for update`;
        else if (order === 'answer-first')
          await tx`select pg_advisory_xact_lock(hashtextextended(${`${f.session.id}:${clientMessageId}`},50))`;
        else
          await tx`select pg_advisory_xact_lock(hashtextextended(${turn.runId},703))`;
      });
      const pending: Promise<unknown>[] = [];
      const start = <T>(work: Promise<T>) => {
        pending.push(work);
        void work.catch(() => {});
        return work;
      };
      try {
        if (order === 'rollback-first') {
          const rollback = start(
            updateNativeQuestionMode(f.reviewer, 'legacy'),
          );
          const writer = await waitingOn(gate.pid, 'native_question_mode');
          const input = start(answer());
          await waitingOn(writer, 'for share');
          expect(
            await isolated.db`select id from allrice_messages where client_message_id=${clientMessageId}`,
          ).toEqual([]);
          gate.release();
          await rollback;
          await expect(input).rejects.toMatchObject({
            code: 'question_expired',
          });
          expect(
            await isolated.db`select id from allrice_messages where client_message_id=${clientMessageId}`,
          ).toEqual([]);
          expect(
            await isolated.db`select user_message_id from allrice_chat_input_requests where client_message_id=${clientMessageId}`,
          ).toEqual([]);
          expect(
            await isolated.db`select id from allrice_conversation_commands where client_user_message_id=${clientMessageId}`,
          ).toEqual([]);
        } else {
          const entry =
            order === 'append-first'
              ? start(
                  sendView(turn, 2, [current, question('new-before-rollback')]),
                )
              : start(answer());
          const reader = await waitingOn(gate.pid, 'pg_advisory_xact_lock');
          const rollback = start(
            updateNativeQuestionMode(f.reviewer, 'legacy'),
          );
          await waitingOn(reader, 'native_question_mode');
          expect((await rows(f.session.id))[0]?.closed_at).toBeNull();
          gate.release();
          await entry;
          await rollback;
          if (order === 'answer-first') {
            expect(
              await isolated.db`select kind from allrice_chat_input_requests where client_message_id=${clientMessageId}`,
            ).toEqual([{ kind: 'ask_user' }]);
            expect(
              await isolated.db`select native_proof from allrice_conversation_commands where client_user_message_id=${clientMessageId} and native_proof is not null`,
            ).toEqual([]);
          } else expect(await rows(f.session.id)).toHaveLength(2);
        }
        expect(
          (await rows(f.session.id)).every((q) => q.closed_at instanceof Date),
        ).toBe(true);
        expect(await phase(f, turn.runId)).toBe('active');
      } finally {
        gate.release();
        await gate.done;
        await Promise.allSettled(pending);
      }
    },
  );

  it.each(['append', 'stop'] as const)(
    'mode rollback atomically refreshes clocks while a competing %s waits on explicit locks',
    async (boundary) => {
      const f = await createExperienceFixture(isolated.db);
      await updateNativeQuestionMode(f.reviewer, 'timed');
      const turn = await startTurn(f);
      const current = question('rollback-race');
      await sendView(turn, 1, [current]);
      expect(await phase(f, turn.runId)).toBe('waiting');
      if (boundary === 'stop')
        await cancelRun(f.owner, f.workspace, turn.runId, {
          reason: 'user_requested',
        });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let ready!: (pid: number) => void;
      const held = new Promise<number>((resolve) => {
        ready = resolve;
      });
      const blocker = isolated.db.begin(async (tx) => {
        const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() pid`;
        await tx`select pg_advisory_xact_lock(hashtextextended(${turn.runId},703))`;
        ready(row!.pid);
        await gate;
      });
      const pending: Promise<unknown>[] = [];
      const start = <T>(work: Promise<T>) => {
        pending.push(work);
        void work.catch(() => {});
        return work;
      };
      const blocked = async (pid: number, query: string, excludePid = -1) => {
        let rows: { pid: number }[] = [];
        await expect
          .poll(
            async () => {
              rows = await isolated.db<{ pid: number }[]>`
            select pid from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid))
              and pid<>${excludePid} and query like ${`%${query}%`} and wait_event_type='Lock'`;
              return rows.length;
            },
            { timeout: 2000, interval: 10 },
          )
          .toBe(1);
        return rows[0]!.pid;
      };
      try {
        const pid = await held;
        // The real stop acknowledgment queues first: it must finish while
        // rollback owns settings, without acquiring settings behind its root.
        const stop =
          boundary === 'stop'
            ? start(completeJob({ ...turn, result: { text: '停止本轮' } }))
            : undefined;
        const stopPid = stop ? await blocked(pid, '703') : -1;
        const rollback = start(updateNativeQuestionMode(f.reviewer, 'legacy'));
        const modePid = await blocked(pid, '703', stopPid);
        const append =
          boundary === 'append'
            ? start(sendView(turn, 2, [current]))
            : undefined;
        if (append) await blocked(modePid, 'native_question_mode');
        release();
        await blocker;
        await rollback;
        await stop;
        await append;
        expect(await phase(f, turn.runId)).toBe(
          boundary === 'stop' ? 'terminal' : 'active',
        );
        expect(await rows(f.session.id)).toMatchObject([
          { closed_at: expect.any(Date) },
        ]);
        if (!stop)
          await completeJob({ ...turn, result: { text: '继续其他工作' } });
      } finally {
        release();
        await blocker;
        await Promise.allSettled(pending);
      }
    },
  );

  it('PR4 current-chat HTTP answer preserves long native IDs and rejects removed or revoked cards atomically', async () => {
    // Web uses Bundler resolution; do not include its sources in the database
    // package's NodeNext typecheck. Vitest still loads the actual route here.
    const { POST: postChatMessage } = await import(
      new URL(
        '../../../apps/web/app/api/v1/sessions/[id]/messages/route.ts',
        import.meta.url,
      ).href
    );
    const f = await createExperienceFixture(isolated.db);
    await updateNativeQuestionMode(f.reviewer, 'timed');
    const turn = await startTurn(f, '请先问我优先采用哪个方案。');
    const current = question('long:call:'.repeat(50));
    const questionId = `${turn.nativeSessionId}:${current.callId}`;
    await sendView(turn, 1, [current]);
    const runtime = {
      organizationId: f.org,
      workspaceId: f.workspace,
      sessionId: f.session.id,
      ownerId: f.owner.actor.id,
      runId: turn.runId,
      workerId: turn.workerId,
    };
    await acquireConversationRuntime({
      ...runtime,
      configChecksum: `sha256:${'a'.repeat(64)}`,
      compactThresholdTokens: 10000,
    });
    await bindConversationThread({
      ...runtime,
      threadId: turn.nativeSessionId,
    });
    const turnId = `${turn.nativeSessionId}:turn:1`;
    const binding = await recordConversationTurn({
      ...runtime,
      threadId: turn.nativeSessionId,
      turnId,
    });
    webIdentity.getRequestContext.mockResolvedValue(f.owner);
    const post = (clientMessageId: string) =>
      postChatMessage(
        new Request(
          `http://127.0.0.1:3200/api/v1/sessions/${f.session.id}/messages?workspaceId=${f.workspace}`,
          {
            method: 'POST',
            headers: {
              origin: 'http://127.0.0.1:3200',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              text: '方案 A',
              clientMessageId,
              deliveryMode: 'steer',
              expectedTurnId: turnId,
              expectedGeneration: binding.generation,
              userQuestionAnswer: {
                questionId,
                answers: [{ id: 'priority', selected: ['方案 A'] }],
              },
            }),
          },
        ),
        { params: Promise.resolve({ id: f.session.id }) },
      );
    const acceptedId = randomUUID();
    const accepted = await post(acceptedId);
    expect(accepted.status).toBe(202);
    expect(questionId.length).toBeGreaterThan(255);
    expect(
      await isolated.db`select content->'interaction'->'answer'->>'questionId' question_id
        from allrice_messages where client_message_id=${acceptedId} and session_id=${f.session.id}`,
    ).toEqual([{ question_id: questionId }]);
    expect(
      await isolated.db`select input_kind,native_proof from allrice_conversation_commands
        where client_user_message_id=${acceptedId} and session_id=${f.session.id}`,
    ).toMatchObject([{ input_kind: 'ask_user', native_proof: null }]);

    for (const boundary of ['removed', 'revoked'] as const) {
      if (boundary === 'removed') await sendView(turn, 2, []);
      else {
        await sendView(turn, 3, [current]);
        await updateNativeQuestionMode(f.reviewer, 'legacy');
        await updateNativeQuestionMode(f.reviewer, 'timed');
      }
      const rejectedId = randomUUID();
      const rejected = await post(rejectedId);
      expect(rejected.status, boundary).toBe(409);
      expect(await rejected.json()).toMatchObject({
        error: { code: 'question_expired' },
      });
      expect(
        await isolated.db`select id from allrice_messages where client_message_id=${rejectedId}`,
      ).toEqual([]);
      expect(
        await isolated.db`select user_message_id from allrice_chat_input_requests where client_message_id=${rejectedId}`,
      ).toEqual([]);
      expect(
        await isolated.db`select id from allrice_conversation_commands where client_user_message_id=${rejectedId}`,
      ).toEqual([]);
      expect(
        (
          await isolated.db.begin((tx) =>
            projectCurrentTaskClock(tx, turn.runId),
          )
        )?.phase,
        `${boundary}: current native membership/revocation facts`,
      ).toBe('active');
      expect
        .soft(
          await phase(f, turn.runId),
          `${boundary}: user-visible persisted clock`,
        )
        .toBe('active');
    }
    await cancelRun(f.owner, f.workspace, turn.runId, {
      reason: 'user_requested',
    });
    await completeJob({ ...turn, result: { text: '停止本轮' } });
  });

  it('upgrades populated pre-0226 chat history without changing legacy model/program waits or clocks', async () => {
    const checkpoint = await createRuntimeFixtureDatabase({
      throughMigration: '0223_agent_preferences.sql',
    });
    const db = checkpoint.db;
    try {
      vi.mocked(client.getDatabase).mockReturnValue(db);
      for (const flag of [
        'ALLRICE_ASSISTANTS_ENABLED',
        'ALLRICE_LOCAL_COMMAND_ENABLED',
        'ALLRICE_RUNTIME_POLICY_ENABLED',
        'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
      ])
        vi.stubEnv(flag, '1');
      for (const file of [
        '0224_retired_provider_cleanup.sql',
        '0225_function_search_path.sql',
      ]) {
        await db.begin(async (tx) => {
          await tx.unsafe(
            await readFile(
              new URL(`../migrations/${file}`, import.meta.url),
              'utf8',
            ),
          );
        });
      }
      const f = await createLocalCommandFixture(db, 'ask', false, {});
      await db`insert into allrice_task_clocks(run_id,organization_id,workspace_id,policy)
        values(${f.rootRunId},${f.org},${f.workspace},${db.json({ ...resolveTaskRuntimePolicy([]) })})`;
      const turn: Turn = {
        ...f.worker,
        runId: f.rootRunId,
        sessionId: f.session,
        nativeSessionId: `dsh-${f.session}`,
        progress: createTaskProgressRuntime(
          { context: f.context, worker: f.worker },
          db,
        ),
      };
      await sendNotice(turn, 'legacy-model');
      await sendNotice(turn, 'program-progress');
      const before =
        await db`select * from allrice_task_clocks where run_id=${turn.runId}`;
      const legacy =
        await db`select * from allrice_task_questions where run_id=${turn.runId} order by question_id`;
      const history =
        await db`select * from allrice_messages where session_id=${f.session} order by id`;
      await db.begin(async (tx) => {
        await tx.unsafe(
          await readFile(
            new URL('../migrations/0226_native_questions.sql', import.meta.url),
            'utf8',
          ),
        );
      });
      expect(await readNativeQuestionMode()).toBe('legacy');
      expect(
        await db`select * from allrice_task_clocks where run_id=${turn.runId}`,
      ).toEqual(before);
      expect(
        await db`select * from allrice_task_questions where run_id=${turn.runId} order by question_id`,
      ).toEqual(legacy);
      expect(
        await db`select * from allrice_messages where session_id=${f.session} order by id`,
      ).toEqual(history);
      expect(await db`select * from allrice_native_questions`).toEqual([]);
      const storedPhase = async () =>
        (await db.begin((tx) => readTaskClock(tx, turn.runId)))?.phase;
      expect(await storedPhase()).toBe('waiting');
      await sendNotice(turn, 'legacy-model', true);
      expect(await storedPhase()).toBe('waiting');
      await sendNotice(turn, 'program-progress', true);
      expect(await storedPhase()).toBe('active');
    } finally {
      vi.mocked(client.getDatabase).mockReturnValue(isolated.db);
      vi.unstubAllEnvs();
      await checkpoint.close();
    }
  }, 120000);

  it('user stops only this turn while a previous turn in the same chat still has an answerable question', async () => {
    const f = await createExperienceFixture(isolated.db);
    await updateNativeQuestionMode(f.reviewer, 'timed');
    const previous = await startTurn(
      f,
      '先问我本周的优先级，没回答也可以继续整理。',
    );
    const old = { ...question('previous:call'), state: 'continued' as const };
    await sendView(previous, 10, [old]);
    await completeJob({
      ...previous,
      result: { text: '计划已整理，优先级仍可补充' },
    });
    const current = await startTurn(f, '再帮我列采购清单，先问我预算。');
    const own = question('current:call', '本轮采购预算是多少？');
    await current.progress({
      action: 'start',
      nativeSessionId: current.nativeSessionId,
      callId: own.callId,
      kind: 'tool',
      name: 'ask_user_question',
      argumentsDigest: `sha256:${'a'.repeat(64)}`,
    });
    await sendNotice(
      current,
      `${current.nativeSessionId}:${own.callId}`,
      false,
      true,
    );
    await sendView(current, 11, [old, own]);
    expect(await phase(f, current.runId)).toBe('waiting');
    // A pending native ask is a wait, but useful model work alongside it still
    // counts as active time. Both inputs enter through the real Worker ports.
    await current.progress({
      action: 'start',
      nativeSessionId: current.nativeSessionId,
      callId: 'model-work',
      kind: 'model',
    });
    expect(await phase(f, current.runId)).toBe('active');
    await current.progress({
      action: 'finish',
      nativeSessionId: current.nativeSessionId,
      callId: 'model-work',
      kind: 'model',
      resultDigest: `sha256:${'b'.repeat(64)}`,
      outcome: 'success',
    });
    expect(await phase(f, current.runId)).toBe('waiting');
    expect(
      await isolated.db`
      select * from allrice_task_questions where run_id in (${previous.runId},${current.runId})`,
    ).toEqual([]);
    expect(await rows(f.session.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          call_id: old.callId,
          source_run_id: previous.runId,
          closed_at: null,
        }),
        expect.objectContaining({
          call_id: own.callId,
          source_run_id: current.runId,
          closed_at: null,
        }),
      ]),
    );
    await cancelRun(f.owner, f.workspace, current.runId, {
      reason: 'user_requested',
    });
    // The real Worker finalization acknowledges the user's stop; no direct
    // closeNativeRunQuestions call or fixture rewrite of terminal state.
    await completeJob({ ...current, result: { text: '停止本轮' } });
    expect(await rows(f.session.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          call_id: old.callId,
          source_run_id: previous.runId,
          state: 'continued',
          closed_at: null,
        }),
        expect.objectContaining({
          call_id: own.callId,
          source_run_id: current.runId,
          state: 'open',
          closed_at: expect.any(Date),
        }),
      ]),
    );
    expect(
      await isolated.db`select state from allrice_runs where id=${current.runId}`,
    ).toMatchObject([{ state: 'canceled' }]);
    expect(await phase(f, current.runId)).toBe('terminal');
  });

  it('newer snapshots cannot rewrite the original question text or source Run', async () => {
    const f = await createExperienceFixture(isolated.db);
    await updateNativeQuestionMode(f.reviewer, 'timed');
    const previous = await startTurn(f);
    const original = question('immutable:call', '原问题：是否采用方案 A？');
    // A restored settled-only view has no body. Removal and a later Run may
    // supply the first nonempty body, but never replace the first source Run.
    await sendView(
      previous,
      18,
      [],
      [
        {
          callId: original.callId,
          answers: [{ id: 'priority', selected: [] }],
        },
      ],
    );
    expect((await rows(f.session.id))[0]?.questions).toEqual([]);
    await sendView(previous, 19, []);
    await completeJob({ ...previous, result: { text: '已整理' } });
    const next = await startTurn(f, '请继续整理其他内容。');
    await sendView(next, 20, [original]);
    expect((await rows(f.session.id))[0]).toMatchObject({
      source_run_id: previous.runId,
      questions: original.questions,
    });
    await sendView(next, 21, [
      {
        ...question(original.callId, '冒名新问题：是否删除全部资料？'),
        state: 'continued',
      },
    ]);
    const [stored] = await rows(f.session.id);
    expect.soft(stored?.source_run_id).toBe(previous.runId);
    expect.soft(stored?.questions).toEqual(original.questions);
    expect.soft(stored?.state).toBe('continued');
    // DSH settles the call without repeating its body; the persisted body must
    // still be the one the owner originally saw.
    await sendView(
      next,
      22,
      [],
      [
        {
          callId: original.callId,
          answers: [{ id: 'priority', selected: [] }],
        },
      ],
    );
    expect((await rows(f.session.id))[0]?.questions).toEqual(
      original.questions,
    );
  });

  it('rejects cross-session and cross-owner/tenant snapshots and unauthorized user reads, stops and mode changes', async () => {
    vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', `sha256:${'a'.repeat(64)}`);
    const f = await createExperienceFixture(isolated.db);
    const foreign = await createExperienceFixture(isolated.db);
    await updateNativeQuestionMode(f.reviewer, 'timed');
    const target = await startTurn(f);
    await sendView(target, 10, [question('shared-call')]);
    const before = await rows(f.session.id);
    const ownOtherSession = await createChatSession(f.owner, {
      workspaceId: f.workspace,
      title: '同属主的其他会话',
    });
    const neighborSession = await createChatSession(f.neighbor, {
      workspaceId: f.workspace,
      title: '同工作区的其他属主',
    });
    const sources = [
      await startTurn(f, '另一个会话的计划', ownOtherSession.id),
      await startTurn(
        { ...f, owner: f.neighbor },
        '其他属主的计划',
        neighborSession.id,
      ),
      await startTurn(foreign),
    ];
    for (const source of sources) {
      await sendView(
        source,
        100,
        [question('shared-call', '冒名问题')],
        [],
        target.nativeSessionId,
      );
      expect(await rows(f.session.id)).toEqual(before);
      expect(await rows(source.sessionId)).toEqual([]);
      // The rejected foreign view must not consume the source's sequence.
      await sendView(source, 1, [question('shared-call')]);
      expect(await rows(source.sessionId)).toMatchObject([
        {
          native_session_id: source.nativeSessionId,
          call_id: 'shared-call',
          source_run_id: source.runId,
          closed_at: null,
        },
      ]);
      expect(
        await isolated.db.begin((tx) =>
          readNativeQuestion(
            tx,
            source.sessionId,
            `${target.nativeSessionId}:shared-call`,
          ),
        ),
      ).toBeNull();
    }
    for (const actor of [f.neighbor, foreign.owner]) {
      await expect(
        getSessionRunTimings(actor, f.session.id),
      ).rejects.toMatchObject({ code: 'artifact_not_found' });
      await expect(
        cancelRun(actor, f.workspace, target.runId, {
          reason: 'user_requested',
        }),
      ).rejects.toThrow();
    }
    await expect(
      updateNativeQuestionMode(f.owner, 'legacy'),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(await readNativeQuestionMode()).toBe('timed');
    expect(await rows(f.session.id)).toEqual(before);
  });

  it('same-sequence replay and expired/wrong Worker leases cannot change the view, cursor or persisted clock', async () => {
    const f = await createExperienceFixture(isolated.db);
    await updateNativeQuestionMode(f.reviewer, 'timed');
    const turn = await startTurn(f);
    await sendView(turn, 10, [question('owned-call')]);
    const before = await rows(f.session.id);
    await sendView(turn, 10, [question('forged-new-call')]);
    await sendView(turn, 9, []);
    expect(await rows(f.session.id)).toEqual(before);
    const clock = await clockRows(turn.runId);
    const events =
      await isolated.db`select * from allrice_run_events where run_id=${turn.runId} order by sequence`;
    for (const invalid of [
      { ...turn, workerId: randomUUID() },
      { ...turn, leaseToken: randomUUID() },
    ])
      await expect(sendView(invalid, 11, [])).rejects.toMatchObject({
        code: 'lease_lost',
      });
    // Simulate expiry of the actual valid token, without sleeping or recycling
    // any other task's lease. The whole event transaction must roll back.
    await isolated.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${turn.jobId}`;
    await expect(sendView(turn, 12, [])).rejects.toMatchObject({
      code: 'lease_lost',
    });
    expect(await rows(f.session.id)).toEqual(before);
    expect(
      await isolated.db`select (native_question_sequences->>${turn.nativeSessionId})::int as sequence from allrice_chat_sessions where id=${f.session.id}`,
    ).toEqual([{ sequence: 10 }]);
    expect(await clockRows(turn.runId)).toEqual(clock);
    expect(
      await isolated.db`select * from allrice_run_events where run_id=${turn.runId} order by sequence`,
    ).toEqual(events);
  });

  it('platform rollback revokes both tenants and in-flight notices, preserves settled answers, and allows only new IDs after re-enable', async () => {
    const f = await createExperienceFixture(isolated.db);
    const other = await createExperienceFixture(isolated.db);
    await updateNativeQuestionMode(f.reviewer, 'timed');
    const a = await startTurn(f),
      b = await startTurn(other);
    const active = [
      question('open'),
      { ...question('continued'), state: 'continued' as const },
    ];
    await sendView(a, 1, [...active, question('settled')]);
    const settled: Settled = [
      { callId: 'settled', answers: [{ id: 'priority', selected: [] }] },
    ];
    await sendView(a, 2, active, settled);
    await sendView(b, 1, [question('other-open')]);
    await updateNativeQuestionMode(f.reviewer, 'legacy');
    expect(await phase(f, a.runId)).toBe('active');
    expect(await phase(other, b.runId)).toBe('active');
    const revoked = await rows(f.session.id);
    expect(revoked).toMatchObject([
      { call_id: 'continued', state: 'continued', closed_at: expect.any(Date) },
      { call_id: 'open', state: 'open', closed_at: expect.any(Date) },
      {
        call_id: 'settled',
        state: 'settled',
        answers: settled[0]!.answers,
        closed_at: null,
      },
    ]);
    expect(await rows(other.session.id)).toMatchObject([
      { closed_at: expect.any(Date) },
    ]);
    await sendView(a, 3, [...active, question('in-flight')], settled);
    expect(
      (await rows(f.session.id)).find((row) => row.call_id === 'in-flight')
        ?.closed_at,
    ).toBeInstanceOf(Date);
    await updateNativeQuestionMode(f.reviewer, 'timed');
    await sendView(
      a,
      4,
      [...active, question('in-flight'), question('new-authorized')],
      settled,
    );
    const enabled = await rows(f.session.id);
    for (const row of revoked.filter((q) => q.state !== 'settled'))
      expect(enabled.find((q) => q.call_id === row.call_id)?.closed_at).toEqual(
        row.closed_at,
      );
    expect(enabled.find((q) => q.call_id === 'settled')).toMatchObject({
      state: 'settled',
      answers: settled[0]!.answers,
      source_run_id: a.runId,
    });
    expect(
      enabled.find((q) => q.call_id === 'in-flight')?.closed_at,
    ).toBeInstanceOf(Date);
    expect(
      enabled.find((q) => q.call_id === 'new-authorized')?.closed_at,
    ).toBeNull();
    expect(await rows(other.session.id)).toMatchObject([
      { closed_at: expect.any(Date) },
    ]);
  });

  it('isolates approved native generations, reused call IDs, empty-snapshot watermarks and retired authority', async () => {
    const f = await createExperienceFixture(isolated.db);
    await updateNativeQuestionMode(f.reviewer, 'timed');
    const turn = await startTurn(f, '先问我方案，换一轮后仍按新问题回答。');
    const q = question('same-call');
    await sendView(turn, 50, [q]);
    const nextId = `${turn.nativeSessionId}-${randomUUID()}`;
    // A familiar prefix is not authorization. Even a runtime thread with no
    // approved pin cannot write a projection or advance the watermark.
    await bindConversationThread({
      organizationId: f.org,
      workspaceId: f.workspace,
      sessionId: f.session.id,
      runId: turn.runId,
      workerId: turn.workerId,
      threadId: nextId,
    });
    await sendView(turn, 1, [question('unapproved')], [], nextId);
    expect(await rows(f.session.id)).toHaveLength(1);
    expect(
      await isolated.db.begin((tx) =>
        readNativeQuestion(
          tx,
          f.session.id,
          `${turn.nativeSessionId}:${q.callId}`,
        ),
      ),
    ).toBeNull();
    await bindNativeQuestionFixture(isolated.db, turn.runId, nextId);
    await sendView(
      turn,
      1,
      [
        {
          ...q,
          questions: [{ ...q.questions[0]!, question: '新一代的问题？' }],
        },
      ],
      [],
      nextId,
    );
    const projected = await rows(f.session.id);
    expect(projected).toHaveLength(2);
    expect(
      projected.find((r) => r.native_session_id === turn.nativeSessionId),
    ).toMatchObject({
      sequence: '50',
      closed_at: expect.any(Date),
      source_run_id: turn.runId,
    });
    const current = projected.find((r) => r.native_session_id === nextId)!;
    expect(current).toMatchObject({
      sequence: '1',
      closed_at: null,
      questions: [{ question: '新一代的问题？' }],
    });
    // Old notifications from the same leased source cannot write the new pin.
    await sendView(turn, 100, [question('old-forged')]);
    expect(await rows(f.session.id)).toHaveLength(2);
    await sendView(turn, 3, [], [], nextId);
    await sendView(turn, 2, [q], [], nextId);
    expect(
      await isolated.db.begin((tx) =>
        readNativeQuestion(tx, f.session.id, `${nextId}:${q.callId}`),
      ),
    ).toBeNull();
    await sendView(turn, 4, [q], [], nextId);
    expect(
      (
        await isolated.db.begin((tx) =>
          readNativeQuestion(tx, f.session.id, `${nextId}:${q.callId}`),
        )
      )?.closed_at,
    ).toBeNull();
    // Returning to the original pin still cannot reset its watermark or undo
    // revocation. Native state is mirrored; permission remains closed.
    await bindNativeQuestionFixture(
      isolated.db,
      turn.runId,
      turn.nativeSessionId,
    );
    await sendView(turn, 49, [question('rollback-forged')]);
    await sendView(turn, 51, [q]);
    expect(await rows(f.session.id)).toHaveLength(2);
    const old = await isolated.db.begin((tx) =>
      readNativeQuestion(
        tx,
        f.session.id,
        `${turn.nativeSessionId}:${q.callId}`,
      ),
    );
    expect(old).toMatchObject({
      closed_at: expect.any(Date),
      sequence: '51',
      source_run_id: turn.runId,
    });
    expect(
      await isolated.db`select native_question_sequences from allrice_chat_sessions where id=${f.session.id}`,
    ).toEqual([
      {
        native_question_sequences: { [turn.nativeSessionId]: 51, [nextId]: 4 },
      },
    ]);
    await completeJob({ ...turn, result: { text: '本轮结束。' } });
  });

  it('a removed revoked identity cannot regain authority or acquire a new source Run when it reappears', async () => {
    const f = await createExperienceFixture(isolated.db);
    await updateNativeQuestionMode(f.reviewer, 'timed');
    const first = await startTurn(f);
    const old = question('revoked:identity');
    await sendView(first, 10, [old]);
    await updateNativeQuestionMode(f.reviewer, 'legacy');
    const closedAt = (await rows(f.session.id))[0]!.closed_at;
    expect(closedAt).toBeInstanceOf(Date);
    // A DSH removal is a newer empty projection, not a manufactured answer.
    await sendView(first, 11, []);
    expect(await rows(f.session.id)).toMatchObject([
      {
        native_present: false,
        closed_at: closedAt,
        source_run_id: first.runId,
      },
    ]);
    expect(
      await isolated.db.begin((tx) =>
        readNativeQuestion(
          tx,
          f.session.id,
          `${first.nativeSessionId}:${old.callId}`,
        ),
      ),
    ).toBeNull();
    expect(await phase(f, first.runId)).toBe('active');
    await completeJob({ ...first, result: { text: '本轮结束' } });
    await updateNativeQuestionMode(f.reviewer, 'timed');
    const next = await startTurn(f, '继续整理其他内容。');
    await sendView(next, 12, [{ ...old, state: 'continued' }]);
    const [reappeared] = await rows(f.session.id);
    expect(reappeared?.native_present).toBe(true);
    if (reappeared) {
      expect.soft(reappeared.closed_at).toEqual(closedAt);
      expect.soft(reappeared.source_run_id).toBe(first.runId);
    }
    expect.soft(await phase(f, next.runId)).toBe('active');
  });
});
