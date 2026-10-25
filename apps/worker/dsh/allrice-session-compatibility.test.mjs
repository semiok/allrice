import { describe, expect, it } from 'vitest';
import { validateAllriceSessionJournal } from './allrice-session-compatibility.mjs';

const sessionId = 'session-1';
const turnId = `${sessionId}:turn:1`;
const inputId = '11111111-1111-4111-8111-111111111111';
const otherInputId = '22222222-2222-4222-8222-222222222222';

// A parked question, its typed answer and the continuation, in journal order.
function chronology() {
  return [
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'allrice/wait/checkpoint',
      data: {
        sessionId,
        questionId: 'question-1',
        turnId,
        questions: [{ id: 'choice', question: 'Continue?' }],
      },
    },
    {
      type: 'allrice/input/request',
      data: {
        inputId,
        digest: `sha256:${'a'.repeat(64)}`,
        messageId: 'question-1',
        turnId,
      },
    },
    {
      type: 'allrice/input/answered',
      data: { inputId, questionId: 'question-1', turnId },
    },
    {
      type: 'allrice/wait/continued',
      data: { questionId: 'question-1', inputId },
    },
  ];
}

const find = (events, type) => events.find((event) => event.type === type);
const clone = (value) => JSON.parse(JSON.stringify(value));

describe('AllRice private session facts', () => {
  it('accepts a bound question, answer and continuation', () => {
    expect(() =>
      validateAllriceSessionJournal({ id: sessionId }, chronology()),
    ).not.toThrow();
  });

  it('rejects a malformed input digest by its payload schema', () => {
    const events = chronology();
    find(events, 'allrice/input/request').data.digest = 'invalid';
    expect(() =>
      validateAllriceSessionJournal({ id: sessionId }, events),
    ).toThrow(/sha256/);
  });

  it.each([
    [
      'a checkpoint for another session',
      (events) => {
        const checkpoint = find(events, 'allrice/wait/checkpoint').data;
        checkpoint.sessionId = 'another-session';
        checkpoint.turnId = 'another-session:turn:1';
      },
    ],
    [
      'a fact attributed to another turn',
      (events) => {
        find(events, 'allrice/input/request').data.turnId =
          `${sessionId}:turn:2`;
      },
    ],
    [
      'an answer without its request',
      (events) => {
        find(events, 'allrice/input/answered').data.inputId = otherInputId;
      },
    ],
    [
      'a continuation without its answer',
      (events) => {
        find(events, 'allrice/wait/continued').data.inputId = otherInputId;
      },
    ],
    [
      'a second continuation of the same question',
      (events) => events.push(clone(events.at(-1))),
    ],
    [
      'a duplicate checkpoint',
      (events) =>
        events.splice(2, 0, clone(find(events, 'allrice/wait/checkpoint'))),
    ],
  ])('rejects %s', (_, mutate) => {
    const events = chronology();
    mutate(events);
    expect(() =>
      validateAllriceSessionJournal({ id: sessionId }, events),
    ).toThrow('ALLRICE_SESSION_PRIVATE_FACTS_INVALID');
  });

  it.each([{ isSeeded: true }, { parentSession: 'root-session' }])(
    'rejects private facts in a seeded or child history %j',
    (extra) => {
      expect(() =>
        validateAllriceSessionJournal(
          { id: sessionId, ...extra },
          chronology(),
        ),
      ).toThrow('ALLRICE_SESSION_PRIVATE_FACTS_INVALID');
    },
  );
});
