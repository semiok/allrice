/* global process, Request */
import { randomUUID } from 'node:crypto';
import { setTimeout, clearTimeout } from 'node:timers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { host, gate, hold, text } from './fixture.mjs';
import { createP27CodexWorkerFixture } from '../../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import {
  acquireConversationRuntime,
  bindConversationThread,
} from '../../../../packages/database/src/conversation/conversation-runtime.ts';
import {
  claimConversationSteer,
  consumeConversationSteer,
} from '../../../../packages/database/src/conversation/conversation-input.ts';
import { appendJobEvent } from '../../../../packages/database/src/execution/queue.ts';
import { createTaskProgressRuntime } from '../../../../packages/database/src/task-progress.ts';
import { beginEmployeeConversationTurn } from '../../src/conversation/turn-lifecycle.ts';
import { nativeRunScope } from '../../src/harness/dsh/run-scope.ts';
import { projectPendingUserQuestion } from '../../../web/lib/chatflow/user-question-state.ts';
import { POST } from '../../../web/app/api/v1/sessions/[id]/messages/route.ts';

const auth = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock('../../../web/lib/identity/session', () => ({
  getRequestContext: auth.context,
}));
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
function within(promise, boundary) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(Error(`native boundary timed out: ${boundary}`)),
        8000,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
}
suite(
  'MET-231 real sibling turns through web projection, message API, PG and Host',
  () => {
    let f;
    afterEach(async () => {
      await f?.close();
    });
    it('answers the still-pending program card on the current turn and consumes its exact Run receipt after another native turn', async () => {
      f = await createP27CodexWorkerFixture({ allowCiDatabase: true });
      const task =
        await f.prepareOrdinaryTask('两个子任务完成后汇总，失败时问我。');
      auth.context.mockResolvedValue(f.context);
      const progress = createTaskProgressRuntime(
        {
          context: task.execution.context,
          worker: task.workflowLease,
          sessionId: task.sessionId,
        },
        f.db,
      );
      const firstEntered = gate(),
        releaseFirst = gate(),
        secondEntered = gate(),
        releaseSecond = gate();
      let firstChild,
        secondCalls = 0;
      const rootId = `dsh-${task.sessionId}`;
      let observe;
      const scope = nativeRunScope(
        {
          subscribe: (listener) => {
            observe = listener;
            return () => {};
          },
        },
        rootId,
        task.runId,
      );
      const h = await host({
        runId: task.runId,
        rootId,
        progress: true,
        questionMode: 'legacy',
        releaseMs: 0,
        nativeTools: ['local.fs.list'],
        onNotification: (notification) => observe(notification),
        bridge: (method, p) => {
          const request = scope.check(p);
          return method === 'allrice/run-authorize'
            ? progress({ action: 'check', nativeSessionId: rootId })
            : progress(request);
        },
        model: async (r) => {
          if (r.sessionId === rootId) return text('等子任务后汇总');
          firstChild ??= r.sessionId;
          if (r.sessionId === firstChild) {
            firstEntered.resolve();
            await hold(r.signal, releaseFirst);
            return text('第一个完成');
          }
          if (++secondCalls <= 3)
            return [
              {
                type: 'tool-call',
                id: randomUUID(),
                name: 'local_fs_list',
                arguments: JSON.stringify({ path: 42 }),
              },
            ];
          secondEntered.resolve();
          await hold(r.signal, releaseSecond);
          return text('第二个完成');
        },
      });
      const owned = {
        organizationId: f.organizationId,
        workspaceId: f.workspaceId,
        sessionId: task.sessionId,
        runId: task.runId,
        workerId: task.workflowLease.workerId,
      };
      await acquireConversationRuntime({
        ...owned,
        ownerId: f.ownerId,
        configChecksum: `sha256:${'a'.repeat(64)}`,
        compactThresholdTokens: 10000,
      });
      const bound = await bindConversationThread({
        ...owned,
        threadId: rootId,
      });
      const events = [];
      const envelope = (type, payload, sourceEvent = null) => ({
        schemaVersion: 3,
        eventId: randomUUID(),
        organizationId: f.organizationId,
        workspaceId: f.workspaceId,
        conversationId: task.sessionId,
        runId: task.runId,
        generation: bound.generation,
        cursor: `test-${events.length}`,
        sequence: events.length,
        harness: 'dsh',
        type,
        occurredAt: new Date().toISOString(),
        payload,
        sourceEvent,
      });
      const recordTurn = (turnId) =>
        beginEmployeeConversationTurn({
          ownership: owned,
          adapterKind: 'dsh',
          threadId: rootId,
          turnId,
          appendEvent: async (type, payload) => {
            await appendJobEvent({ ...task.workflowLease, type, payload });
            events.push(envelope(type, payload));
          },
        });
      const currentTurn = () =>
        `${rootId}:turn:${h.root.session.snapshotEvents().findLast((e) => e.type === 'turn/start').data.turn}`;
      try {
        await h.prompt('开始分工。');
        await h.root.whenIdle();
        const askedTurn = currentTurn();
        await recordTurn(askedTurn);
        const first = await h.spawn();
        await within(firstEntered.promise, 'first child model');
        await h.spawn();
        const waiting = h.wait();
        void waiting.catch(() => {});
        await expect
          .poll(() => h.server.pendingUserQuestions.get(rootId))
          .toBeTruthy();
        const q = h.server.pendingUserQuestions.get(rootId);
        const asked = envelope(
          'harness.native',
          { turnId: askedTurn },
          {
            id: q.questionId,
            type: 'session/user-question',
            occurredAt: new Date().toISOString(),
            payload: {
              questionId: q.questionId,
              questions: q.questions,
              progress: q.progress,
            },
          },
        );
        events.push(asked);
        expect(projectPendingUserQuestion(events)?.turnId).toBe(askedTurn);
        releaseFirst.resolve();
        await within(first.result, 'first child result');
        await expect.poll(currentTurn).not.toBe(askedTurn);
        await recordTurn(currentTurn());
        const card = projectPendingUserQuestion(events);
        expect(card.turnId).toBe(currentTurn());
        expect(asked.payload.turnId).toBe(askedTurn);
        const submit = (expectedTurnId) =>
          POST(
            new Request(
              `http://localhost/api/v1/sessions/${task.sessionId}/messages?workspaceId=${f.workspaceId}`,
              {
                method: 'POST',
                headers: {
                  origin: 'http://localhost',
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  text: '重新检查后继续',
                  clientMessageId: randomUUID(),
                  deliveryMode: 'steer',
                  expectedTurnId,
                  expectedGeneration: card.generation,
                  userQuestionAnswer: {
                    questionId: card.questionId,
                    answers: [
                      { id: 'runtime-progress', selected: ['重新检查后继续'] },
                    ],
                  },
                }),
              },
            ),
            { params: Promise.resolve({ id: task.sessionId }) },
          );
        const stale = await submit(askedTurn);
        expect(stale.status).toBe(409);
        expect(await stale.json()).toMatchObject({
          error: { code: 'input_turn_changed' },
        });
        const submitted = await submit(card.turnId);
        expect(submitted.status, await submitted.text()).toBe(202);
        const command = await claimConversationSteer({
          ...owned,
          generation: card.generation,
          turnId: card.turnId,
        });
        expect(command.inputKind).toBe('ask_user');
        const params = {
          sessionId: rootId,
          runId: task.runId,
          turnId: command.turnId,
          inputId: command.clientUserMessageId,
          kind: command.inputKind,
          text: command.message,
        };
        await expect(
          h.server.steer({ ...params, turnId: askedTurn }),
        ).rejects.toThrow('INPUT_TURN_CHANGED');
        const proof = await within(h.server.steer(params), 'question adoption');
        expect(proof).toMatchObject({
          status: 'adopted',
          runId: task.runId,
          turnId: card.turnId,
          messageId: q.questionId,
        });
        for (const patch of [
          { runId: randomUUID() },
          { messageId: 'other-question' },
          { checkpoint: 'step_user_message' },
          { turnId: askedTurn },
        ])
          await expect(
            consumeConversationSteer({
              commandId: command.id,
              workerId: owned.workerId,
              proof: { ...proof, ...patch },
            }),
          ).rejects.toThrow('INPUT_ADOPTION_PROOF_REQUIRED');
        await within(secondEntered.promise, 'second child after answer');
        await within(h.root.whenIdle(), 'root turn after answer');
        releaseSecond.resolve();
        await within(waiting, 'all children settled');
        expect(currentTurn()).not.toBe(card.turnId);
        await recordTurn(currentTurn());
        await consumeConversationSteer({
          commandId: command.id,
          workerId: owned.workerId,
          proof,
        });
        expect(
          await f.db`select state from allrice_conversation_commands where id=${command.id}`,
        ).toEqual([{ state: 'consumed' }]);
        expect(
          await f.db`select mode,state from allrice_conversation_followups where run_id=${command.followupRunId}`,
        ).toEqual([{ mode: 'steer_only', state: 'consumed' }]);
        expect(
          await f.db`select lease_token from allrice_jobs where id=${task.workflowLease.jobId}`,
        ).toEqual([{ lease_token: task.workflowLease.leaseToken }]);
      } finally {
        releaseFirst.resolve();
        releaseSecond.resolve();
        await h.server.closeRoot(rootId);
      }
    }, 30000);
  },
);
