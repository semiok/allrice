import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  noRunningDescendants,
  treeQuiescent,
} from '../../dsh/allrice-agent-tree.mjs';
import { host, text } from './fixture.mjs';

it('T7 multiple settled children stay ordered in a blocked question inbox until the answer', async () => {
  let rootSteps = 0;
  const h = await host({
    model: async (request) => {
      if (request.sessionId === 'pr0-root' && ++rootSteps === 1)
        return [
          {
            type: 'tool-call',
            id: 'ask',
            name: 'ask_user_question',
            arguments: JSON.stringify({
              timeout: -1,
              questions: [
                {
                  id: 'go',
                  question: '要继续吗？',
                  options: [{ label: '继续' }, { label: '停止' }],
                },
              ],
            }),
          },
        ];
      return text('完成');
    },
  });
  await h.prompt('请先问我要不要继续。');
  await expect
    .poll(() => h.server.pendingUserQuestions.has(h.root.id))
    .toBe(true);
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const child = await h.spawn(h.root, `第 ${i} 项`);
    ids.push(child.childId);
    await child.result;
  }
  expect(noRunningDescendants(h.root)).toBe(true);
  expect(treeQuiescent(h.root)).toBe(false);
  expect(
    h.root.inbox.nextStep.map((message) => message.source.senderSessionId),
  ).toEqual(ids);
  const question = h.server.pendingUserQuestions.get(h.root.id);
  await h.server.handleRequest('session/steer', {
    sessionId: h.root.id,
    inputId: randomUUID(),
    turnId: `${h.root.id}:turn:1`,
    kind: 'ask_user',
    text: `allrice:user-question:v1:${JSON.stringify({ questionId: question.questionId, answers: [{ id: 'go', selected: ['继续'] }] })}`,
  });
  await h.wait();
  const next = h.calls.filter((request) => request.sessionId === h.root.id)[1];
  const received = JSON.stringify(next.messages);
  expect(received.indexOf(ids[0])).toBeLessThan(received.indexOf(ids[1]));
  expect(received).toContain('继续');
  expect(treeQuiescent(h.root)).toBe(true);
});
