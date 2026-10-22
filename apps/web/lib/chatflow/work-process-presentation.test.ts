import { describe, expect, it } from 'vitest';
import type { ChatFlowEventEnvelope } from '@allrice/contracts';
import { presentationPolicyFor } from '../../app/chatflow/dsh-upstream/presentation/presentation-policy';
import { projectWorkProgress } from './work-progress';
import {
  workProcessDisplayState,
  workProcessPresentation,
} from './work-process-presentation';

const event = (
  sequence: number,
  type: ChatFlowEventEnvelope['type'],
  payload: Record<string, unknown> = {},
) =>
  ({
    eventId: `event-${sequence}`,
    sequence,
    generation: 4,
    runId: 'run',
    type,
    payload,
  }) as ChatFlowEventEnvelope;
const completed = event(3, 'assistant.text.completed', {
  generation: 4,
  turnId: 'turn:9',
  replyId: 'answer',
  text: '结果',
});
const presentation = workProcessPresentation([completed], [], 'run', false);
const display = (
  overrides: Partial<Parameters<typeof workProcessDisplayState>[0]> = {},
) =>
  workProcessDisplayState({
    policy: presentationPolicyFor('detailed', 'completion'),
    presentation,
    running: false,
    failed: false,
    canceled: false,
    hasHistory: true,
    ...overrides,
  });

describe('native work display over accepted AllRice facts', () => {
  it('keeps the newest completed process open until an accepted new-turn input', () => {
    const policy = presentationPolicyFor('detailed', 'next-input');
    expect(display({ policy })).toMatchObject({
      open: true,
      groupSteps: false,
    });
    expect(
      display({
        policy,
        presentation: { ...presentation, hasNextInput: true },
      }),
    ).toMatchObject({ open: false, groupSteps: true });
    // A same-turn adopted steering input is separate from a new-turn input.
    expect(
      display({
        policy,
        presentation: { ...presentation, hasInterleavedInput: true },
      }),
    ).toMatchObject({ open: true, canFold: false });
  });
  it.each(['running', 'failed', 'canceled'] as const)(
    'keeps %s outcomes visible even after the next input',
    (state) => {
      expect(
        display({
          [state]: true,
          presentation: { ...presentation, hasNextInput: true },
        }),
      ).toMatchObject({ open: true, canFold: false });
    },
  );
  it('honors manual disclosure for this answer while a later answer resets it', () => {
    const disclosure = { presentation, open: true };
    expect(display({ disclosure }).open).toBe(true);
    const later = workProcessPresentation(
      [
        {
          ...completed,
          payload: { ...completed.payload, replyId: 'revision' },
        },
      ],
      [],
      'run',
      true,
    );
    expect(display({ disclosure, presentation: later }).open).toBe(false);
    expect(
      display({
        policy: presentationPolicyFor('standard', 'next-input'),
        disclosure: { presentation, open: false },
      }).open,
    ).toBe(false);
  });
  it('preserves manual expansion when timing/usage arrives without identity payloads', () => {
    const later = workProcessPresentation(
      [completed, event(4, 'harness.native')],
      [],
      'run',
      true,
    );
    expect(later.answerGeneration).toBe(presentation.answerGeneration);
    expect(
      display({
        disclosure: { presentation, open: true },
        presentation: later,
      }).open,
    ).toBe(true);
  });
  it('distinguishes native generations from envelope metadata when payload lacks it', () => {
    const before = workProcessPresentation(
      [event(1, 'harness.native')],
      [],
      'run',
      false,
    );
    const after = workProcessPresentation(
      [{ ...event(2, 'harness.native'), generation: 5 }],
      [],
      'run',
      false,
    );
    expect(before.answerGeneration).not.toBe(after.answerGeneration);
  });
  it('keeps verbose history and compact/standard live groups distinct from detailed', () => {
    expect(display({ policy: presentationPolicyFor('verbose') })).toMatchObject(
      {
        canFold: false,
        open: true,
        groupSteps: false,
      },
    );
    expect(display({ running: true }).groupSteps).toBe(false);
    for (const mode of ['compact', 'standard'] as const)
      expect(
        display({ running: true, policy: presentationPolicyFor(mode) })
          .groupSteps,
      ).toBe(true);
  });
  it('recognizes final answers from completion or persisted fallback, never a live last delta', () => {
    const delta = event(1, 'assistant.text.delta', {
      replyId: 'answer',
      text: '部分',
    });
    const live = projectWorkProgress([delta], '', true);
    expect(
      workProcessPresentation([delta], live.parts, 'run', false).finalReplyId,
    ).toBeUndefined();
    const done = projectWorkProgress([delta, completed], '结果', false);
    expect(
      workProcessPresentation([delta, completed], done.parts, 'run', false)
        .finalReplyId,
    ).toBe('reply:answer');
    const history = workProcessPresentation(
      [],
      [{ kind: 'reply', id: 'history-reply', sequence: 0, text: '结果' }],
      'run',
      false,
    );
    expect(history.finalReplyId).toBe('history-reply');
  });
});
