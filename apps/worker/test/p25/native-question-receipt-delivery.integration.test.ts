/** Actual sendChat -> Worker -> Host -> PG, including the final commit guard.
 * Checked eligibility is synthetic; this does not enable PR1c or the rollout. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Rollout from '../../../../packages/database/src/final-delivery-rollout.ts';
import { maintainQueue } from '../../../../packages/database/src/execution/queue.ts';
import {
  setupNativeReplyEmployee as setup,
  sendNativeReplyMessage as send,
  executeNativeReplyJob as execute,
} from './native-question-employee.fixture.ts';
import { readCheckedFinalDeliveryForExecution } from '../../src/final-delivery/checked-delivery.ts';
import { DshProtocolClient } from '../../src/harness/dsh-protocol-client.ts';
import { gate } from '../p24/fixture.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('PR5 checked exact native question receipts', () => {
  let f: Awaited<ReturnType<typeof setup>>;
  afterEach(async () => {
    await f?.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }, 30000);
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
  const checked = () => {
    const freeze = Rollout.freezeDeliveryPolicy;
    vi.spyOn(Rollout, 'freezeDeliveryPolicy').mockImplementation((tx, input) =>
      freeze(tx, { ...input, eligible: true }),
    );
  };
  const turns = (runId: string) =>
    f.db`select id from allrice_run_events where run_id=${runId} and event_type='turn.started'`;
  const proof = async (result: object, lease: object) => {
    const receipt = readCheckedFinalDeliveryForExecution(lease, result);
    expect(receipt.coverage).toBe('checked_native_v1');
    if (receipt.coverage === 'checked_native_v1') {
      expect(receipt.proof.durableSeq).toBeGreaterThan(0);
      expect(receipt.proof.nativeBindingId).toBeTruthy();
    }
  };
  const receipt = async (result: object, lease: object) => {
    expect(readCheckedFinalDeliveryForExecution(lease, result).coverage).toBe(
      'native_question_receipt',
    );
  };
  it.each(['same', 'different', 'consumed-reclaim', 'source-reclaim'] as const)(
    'keeps checked origin/proof for a real resumed turn, but zero-turn %s gets only its exact receipt',
    async (phase) => {
      f = await setup(async (_r, n) => (n === 1 ? ask : { text: '已完成。' }));
      checked();
      const source = await send(f, '需要决定的地方先问我。');
      await execute(f, source.run.id, 'succeeded', { afterHandler: proof });
      const [q] =
        await f.db`select * from allrice_native_questions where session_id=${f.chat.id}`;
      const answer = {
        questionId: `${q!.native_session_id}:${q!.call_id}`,
        answers: [{ id: 'choice', selected: [] as string[] }],
      };
      const first = await send(f, '跳过', answer);
      const duplicate =
        phase === 'source-reclaim'
          ? first
          : await send(f, '另一客户端回答', {
              ...answer,
              answers: [
                { id: 'choice', selected: phase === 'different' ? ['B'] : [] },
              ],
            });
      await execute(
        f,
        first.run.id,
        phase === 'source-reclaim' ? 'running' : 'succeeded',
        {
          afterHandler: proof,
          crashAfterHandler: phase === 'source-reclaim',
        },
      );
      expect((await turns(first.run.id)).length).toBeGreaterThan(0);
      const [usage] =
        await f.db`select input_tokens,output_tokens from allrice_route_decisions where run_id=${first.run.id} and status='succeeded'`;
      expect(
        Number(usage!.input_tokens) + Number(usage!.output_tokens),
      ).toBeGreaterThan(0);
      if (phase === 'consumed-reclaim')
        await execute(f, duplicate.run.id, 'running', {
          crashAfterHandler: true,
          afterHandler: receipt,
        });
      if (phase.endsWith('reclaim')) {
        await f.restartHost();
        expect((await maintainQueue()).recover_lease).toBe(1);
      }
      const requests = f.model.requests.length,
        before = await turns(duplicate.run.id);
      const prompt = vi.spyOn(DshProtocolClient.prototype, 'prompt');
      const result = await execute(f, duplicate.run.id, 'succeeded', {
        afterHandler: receipt,
      });
      expect(result.result.answer).toContain(
        phase === 'different' ? '没有被采用' : '已经回答过',
      );
      expect(result.result.usage).toEqual({
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      });
      expect(result.result.usageComplete).toBe(true);
      expect(f.model.requests).toHaveLength(requests);
      expect(await turns(duplicate.run.id)).toEqual(before);
      expect(prompt).not.toHaveBeenCalled();
      expect(
        await f.db`select state,error_code from allrice_conversation_commands where followup_run_id=${duplicate.run.id}`,
      ).toEqual([
        {
          state: phase === 'different' ? 'rejected' : 'consumed',
          error_code:
            phase === 'different' ? 'QUESTION_ANSWER_NOT_ADOPTED' : null,
        },
      ]);
    },
    60000,
  );
  it.each(['legacy', 'checked', 'revoked'] as const)(
    'real foreground Host rejects two admitted digests; each FIFO release revalidates them (%s)',
    async (mode) => {
      const ready = gate(),
        admitted = gate(),
        finish = gate();
      f = await setup(async (_r, n) => {
        if (n === 1)
          return {
            nativeTool: {
              ...ask.nativeTool,
              arguments: { ...ask.nativeTool.arguments, timeout: -1 },
            },
          };
        await finish.promise;
        return { text: '已完成。' };
      });
      if (mode !== 'legacy') checked();
      const steer = f.adapter.steer.bind(f.adapter);
      let rejections = 0;
      vi.spyOn(f.adapter, 'steer').mockImplementation(async (input) => {
        await admitted.promise;
        try {
          return await steer(input);
        } catch (error) {
          expect(String(error)).toContain('QUESTION_ANSWER_NOT_ADOPTED');
          if (++rejections === 2) finish.open();
          throw error;
        }
      });
      const source = await send(f, '阻塞提问，等我回答。');
      const running = execute(f, source.run.id, 'succeeded', {
        onEvent: async (e) => {
          if (
            e.type === 'native.event' &&
            e.sourceEventType === 'session/user-questions' &&
            (e.sourcePayload as { questions?: { active?: unknown[] } })
              ?.questions?.active?.length
          )
            ready.open();
        },
      });
      try {
        await ready.promise;
        const [q] =
          await f.db`select * from allrice_native_questions where session_id=${f.chat.id}`;
        expect(q!.state).toBe('open');
        const answer = {
          questionId: `${q!.native_session_id}:${q!.call_id}`,
          answers: [{ id: 'choice', selected: [] as string[] }],
        };
        await send(f, '跳过', answer);
        const conflicts = [];
        for (let i = 0; i < 2; i++) {
          const reply = await send(f, '选择 B', {
            ...answer,
            answers: [{ id: 'choice', selected: ['B'] }],
          });
          expect(reply.delivery).toBe('steer_pending');
          conflicts.push(reply.fallbackRunId!);
        }
        admitted.open();
        await running;
        expect(rejections).toBe(2);
        expect(
          await f.db`select state,error_code from allrice_conversation_commands where followup_run_id=any(${conflicts}::uuid[])`,
        ).toEqual(
          conflicts.map(() => ({
            state: 'rejected',
            error_code: 'QUESTION_ANSWER_NOT_ADOPTED',
          })),
        );
        const requests = f.model.requests.length;
        for (const [index, id] of conflicts.entries()) {
          if (mode === 'revoked' && index === 1)
            await f.db`update allrice_employee_assignments set active=false where id=${f.identity.assignment}`;
          const result = await execute(
            f,
            id,
            mode === 'revoked' && index === 1 ? 'failed' : 'succeeded',
          );
          if (result.state === 'succeeded')
            expect(result.result.usage).toEqual({
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
            });
          expect(await turns(id)).toHaveLength(0);
        }
        expect(f.model.requests).toHaveLength(requests);
      } finally {
        admitted.open();
        finish.open();
        await running;
      }
    },
    60000,
  );
});
