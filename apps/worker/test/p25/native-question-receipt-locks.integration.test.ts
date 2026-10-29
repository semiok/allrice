/** Real Worker/Host/PG receipts: deterministic transaction interleavings.
 * Only rollout eligibility and the loopback model are synthetic. */
import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Rollout from '../../../../packages/database/src/final-delivery-rollout.ts';
import {
  createSession,
  authenticateSession,
} from '../../../../packages/database/src/identity.ts';
import {
  listOrganizationPeople,
  setOrganizationAccountStatus,
} from '../../../../packages/database/src/organization-administration.ts';
import { updateNativeQuestionMode } from '../../../../packages/database/src/native-questions.ts';
import {
  setupNativeReplyEmployee as setup,
  sendNativeReplyMessage as send,
  executeNativeReplyJob as execute,
} from './native-question-employee.fixture.ts';
import { readCheckedFinalDeliveryForExecution } from '../../src/final-delivery/checked-delivery.ts';
import { gate } from '../p24/fixture.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('PR5 exact receipt completion locks', () => {
  let f: Awaited<ReturnType<typeof setup>>;
  afterEach(async () => {
    await f?.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }, 30000);
  async function prepare(anotherQuestion = false) {
    const ask = {
      nativeTool: {
        name: 'ask_user_question',
        arguments: {
          questions: [
            {
              id: 'choice',
              question: '先做哪项？',
              options: [{ label: 'A' }, { label: 'B' }],
            },
          ],
          timeout: 1,
        },
      },
    };
    f = await setup(async (_r, n) =>
      n === 1 || (anotherQuestion && n === 3) ? ask : { text: '已完成。' },
    );
    const freeze = Rollout.freezeDeliveryPolicy;
    vi.spyOn(Rollout, 'freezeDeliveryPolicy').mockImplementation((tx, input) =>
      freeze(tx, { ...input, eligible: true }),
    );
    const source = await send(f, '需要决定的地方先问我。');
    await execute(f, source.run.id);
    const [q] =
      await f.db`select * from allrice_native_questions where session_id=${f.chat.id}`;
    const answer = {
      questionId: `${q!.native_session_id}:${q!.call_id}`,
      answers: [{ id: 'choice', selected: [] as string[] }],
    };
    const first = await send(f, '跳过', answer),
      duplicate = await send(f, '另一客户端跳过', answer);
    await execute(f, first.run.id, 'succeeded', {
      afterHandler: async (result, lease) => {
        const coverage = readCheckedFinalDeliveryForExecution(lease, result);
        expect(coverage.coverage).toBe('checked_native_v1');
        if (coverage.coverage === 'checked_native_v1')
          expect(coverage.proof.durableSeq).toBeGreaterThan(0);
      },
    });
    if (anotherQuestion)
      expect(
        await f.db`select state from allrice_native_questions where session_id=${f.chat.id} order by state`,
      ).toEqual([{ state: 'continued' }, { state: 'settled' }]);
    return { runId: duplicate.run.id, requests: f.model.requests.length };
  }
  async function hold(take: (tx: TransactionSql) => Promise<unknown>) {
    const release = gate(),
      ready = gate();
    let pid = 0;
    const done = f.db.begin(async (tx) => {
      await take(tx);
      const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() pid`;
      pid = row!.pid;
      ready.release();
      await release.promise;
    });
    void done.catch(() => ready.release());
    await ready.promise;
    if (!pid) await done;
    return { pid, release: release.release, done };
  }
  async function waitingOn(pid: number, query: string) {
    let rows: { pid: number }[] = [];
    await expect
      .poll(
        async () => {
          rows = await f.db<{ pid: number }[]>`select pid from pg_stat_activity
        where ${pid}=any(pg_blocking_pids(pid)) and query like ${`%${query}%`} and wait_event_type='Lock'`;
          return rows.length;
        },
        { timeout: 3000, interval: 10 },
      )
      .toBe(1);
    return rows[0]!.pid;
  }
  async function admin() {
    const id = randomUUID(),
      email = `${id}@receipt-admin.test`;
    await f.db`insert into allrice_users(id,email,display_name,password_hash) values(${id},${email},'Receipt administrator','unused-fixture-password')`;
    await f.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${f.identity.org},${f.identity.workspace},${id},'admin')`;
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', email);
    const login = await createSession(id);
    return (await authenticateSession(login.token, {
      organizationId: f.identity.org,
      workspaceId: f.identity.workspace,
    }))!;
  }
  async function noNewWork(
    runId: string,
    requests: number,
    succeeded: boolean,
  ) {
    expect(f.model.requests).toHaveLength(requests);
    expect(
      await f.db`select id from allrice_run_events where run_id=${runId} and event_type='turn.started'`,
    ).toHaveLength(0);
    const [run] = await f.db`select result from allrice_runs where id=${runId}`;
    if (succeeded)
      expect(run!.result.usage).toEqual({
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      });
    else
      expect(
        await f.db`select id from allrice_run_events where run_id=${runId} and event_type='run.succeeded'`,
      ).toHaveLength(0);
  }
  it('holds current account authority until the blocked terminal message commits, then real revocation proceeds', async () => {
    const { runId, requests } = await prepare();
    const actor = await admin();
    const person = (
      await listOrganizationPeople(actor, f.identity.org)
    ).people.find((p) => p.userId === f.identity.user)!;
    const ready = gate();
    let held: Awaited<ReturnType<typeof hold>>;
    const running = execute(f, runId, 'succeeded', {
      afterHandler: async (result, lease) => {
        expect(
          readCheckedFinalDeliveryForExecution(lease, result).coverage,
        ).toBe('native_question_receipt');
        held = await hold(async (tx) => {
          await tx`select id from allrice_messages where id=(select assistant_message_id from allrice_employee_runs where run_id=${runId}) for update`;
        });
        ready.release();
      },
    });
    void running.catch(() => ready.release());
    await ready.promise;
    let revocation: ReturnType<typeof setOrganizationAccountStatus> | undefined;
    try {
      const completing = await waitingOn(held!.pid, 'update allrice_messages');
      revocation = setOrganizationAccountStatus(
        actor,
        f.identity.org,
        f.identity.user,
        { active: false, expectedVersion: person.version },
      );
      void revocation.catch(() => {});
      await waitingOn(completing, 'allrice_users');
    } finally {
      held!.release();
      await held!.done;
      await running;
      await revocation;
    }
    expect(
      (
        await f.db`select status from allrice_users where id=${f.identity.user}`
      )[0]!.status,
    ).toBe('disabled');
    await noNewWork(runId, requests, true);
  }, 60000);
  it('rejects the receipt when real account revocation commits before completion', async () => {
    const { runId, requests } = await prepare();
    const actor = await admin();
    const person = (
      await listOrganizationPeople(actor, f.identity.org)
    ).people.find((p) => p.userId === f.identity.user)!;
    await execute(f, runId, 'failed', {
      afterHandler: async () => {
        await setOrganizationAccountStatus(
          actor,
          f.identity.org,
          f.identity.user,
          { active: false, expectedVersion: person.version },
        );
      },
    });
    await noNewWork(runId, requests, false);
  }, 60000);
  it('rolls back the entire terminal receipt when a message lock outlasts policy expiry', async () => {
    const { runId, requests } = await prepare();
    const ready = gate();
    let held: Awaited<ReturnType<typeof hold>>;
    const running = execute(f, runId, 'failed', {
      afterHandler: async () => {
        await f.db`update allrice_policy_snapshots set expires_at=clock_timestamp()+interval '3 seconds' where id=(select policy_snapshot_id from allrice_runs where id=${runId})`;
        held = await hold(async (tx) => {
          await tx`select id from allrice_messages where id=(select assistant_message_id from allrice_employee_runs where run_id=${runId}) for update`;
        });
        ready.release();
      },
    });
    void running.catch(() => ready.release());
    await ready.promise;
    try {
      await waitingOn(held!.pid, 'update allrice_messages');
      // Real DB time, not a fake clock or altered policy after the guard.
      await expect
        .poll(
          async () =>
            (
              await f.db`select expires_at<=clock_timestamp() expired from allrice_policy_snapshots where id=(select policy_snapshot_id from allrice_runs where id=${runId})`
            )[0]!.expired,
          { timeout: 5000, interval: 20 },
        )
        .toBe(true);
    } finally {
      held!.release();
      await held!.done;
      await running;
    }
    await noNewWork(runId, requests, false);
  }, 60000);
  it.each(['receipt-first', 'rollback-first'] as const)(
    'orders mode before 703/root/clock/Job with a real continued question: %s',
    async (order) => {
      const { runId, requests } = await prepare(true);
      const ready = gate(),
        start = gate();
      let rootLock: Awaited<ReturnType<typeof hold>>;
      const running = execute(
        f,
        runId,
        order === 'receipt-first' ? 'succeeded' : 'failed',
        {
          afterHandler: async (result, lease) => {
            expect(
              readCheckedFinalDeliveryForExecution(lease, result).coverage,
            ).toBe('native_question_receipt');
            rootLock = await hold(async (tx) => {
              await tx`select pg_advisory_xact_lock(hashtextextended(${runId},703))`;
            });
            ready.release();
            await start.promise;
          },
        },
      );
      void running.catch(() => ready.release());
      await ready.promise;
      let rollback: ReturnType<typeof updateNativeQuestionMode> | undefined;
      try {
        if (order === 'receipt-first') {
          start.release();
          const completing = await waitingOn(
            rootLock!.pid,
            'pg_advisory_xact_lock',
          );
          rollback = updateNativeQuestionMode(f.context, 'legacy');
          void rollback.catch(() => {});
          await waitingOn(completing, 'native_question_mode');
        } else {
          rollback = updateNativeQuestionMode(f.context, 'legacy');
          void rollback.catch(() => {});
          const reverting = await waitingOn(
            rootLock!.pid,
            'pg_advisory_xact_lock',
          );
          start.release();
          await waitingOn(reverting, 'native_question_mode');
        }
      } finally {
        start.release();
        rootLock!.release();
        await rootLock!.done;
        await Promise.all([running, rollback]);
      }
      expect(
        (
          await f.db`select closed_at from allrice_native_questions where session_id=${f.chat.id} and state='continued'`
        )[0]!.closed_at,
      ).toBeTruthy();
      expect(
        (
          await f.db`select closed_at from allrice_native_questions where session_id=${f.chat.id} and state='settled'`
        )[0]!.closed_at,
      ).toBeNull();
      await noNewWork(runId, requests, order === 'receipt-first');
    },
    60000,
  );
});
