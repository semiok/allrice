/* global structuredClone, URL */
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { verifyRestoredFinalReplyOrigin } from '../../dsh/allrice-final-reply-origin.mjs';

const fixture = (
  await readFile(
    new URL('./fixtures/final-relay-closure.jsonl', import.meta.url),
    'utf8',
  )
)
  .trim()
  .split('\n')
  .map(JSON.parse);
const cut = () => {
  const [header, ...events] = structuredClone(fixture);
  return {
    session: { id: header.id, header, snapshotEvents: () => events },
    entry: { runId: 'current-run' },
    origin: {
      schemaVersion: 1,
      rootRunId: 'current-run',
      nativeSessionId: header.id,
      starts: [
        {
          runEventId: 'turn-start',
          runEventSequence: 7,
          turnId: `${header.id}:turn:1`,
        },
      ],
    },
    events,
  };
};
const read = ({ session, entry, origin }) =>
  verifyRestoredFinalReplyOrigin(session, entry, origin).event;

it('真实 Dev 脱敏切片：relay 后空答复、notice 后再空答复，closing 仍为原生 seq 60', () => {
  const input = cut();
  const before = structuredClone(input.events);
  expect(
    input.events
      .filter((e) => e.type === 'user/message')
      .map((e) => e.data.source.kind),
  ).toEqual(['subagent-settled', 'agent-message', 'subagent-settled']);
  expect(read(input)).toBe(input.events.find((e) => e.seq === 60));
  expect(read(input)).toMatchObject({
    seq: 60,
    time: 1793385059999,
    data: {
      turn: 1,
      step: 8,
      message: {
        id: 'message-60',
        content: expect.arrayContaining([
          { type: 'text', text: '甲：21\n乙：55' },
        ]),
      },
    },
  });
  expect(input.events).toEqual(before);
});

it.each([
  [
    'other Run',
    (f) => {
      f.origin.rootRunId = 'other-run';
    },
  ],
  [
    'other Session',
    (f) => {
      f.origin.nativeSessionId = 'other-session';
    },
  ],
  [
    'wrong header',
    (f) => {
      f.session.header.id = 'other-session';
    },
  ],
  [
    'seeded root',
    (f) => {
      f.session.header.isSeeded = true;
    },
  ],
  [
    'child root',
    (f) => {
      f.session.header.parentSession = 'parent';
    },
  ],
  [
    'unanchored turn',
    (f) => {
      f.origin.starts[0].turnId = 'closing-root:turn:2';
    },
  ],
  [
    'duplicate control',
    (f) => {
      f.origin.starts.push(f.origin.starts[0]);
    },
  ],
  [
    'missing end',
    (f) => {
      f.events.pop();
    },
  ],
  [
    'aborted turn',
    (f) => {
      f.events.at(-1).data.reason.kind = 'aborted';
    },
  ],
  [
    'new unanchored turn',
    (f) => {
      f.events.push({ seq: 74, type: 'turn/start', data: { turn: 2 } });
    },
  ],
])('脱敏事实重放拒绝 %s', (_name, mutate) => {
  const input = cut();
  mutate(input);
  expect(() => read(input)).toThrow('assistant_completion_origin_unavailable');
});

it('当前已锚定 turn 没有正文时，绝不借用前一 turn 的 21/55', () => {
  const input = cut();
  const empty = structuredClone(input.events.find((e) => e.seq === 71));
  Object.assign(empty, { seq: 75 });
  Object.assign(empty.data, { turn: 2, step: 1 });
  empty.data.message.id = 'new-turn-empty';
  input.origin.starts.push({
    runEventId: 'turn-start-2',
    runEventSequence: 9,
    turnId: 'closing-root:turn:2',
  });
  input.events.push({ seq: 74, type: 'turn/start', data: { turn: 2 } }, empty, {
    seq: 76,
    type: 'turn/end',
    data: { turn: 2, reason: { kind: 'completed' } },
  });
  expect(read(input)).toBe(empty);
});
