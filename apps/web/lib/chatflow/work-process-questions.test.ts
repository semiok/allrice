import { describe, expect, it } from 'vitest';
import type { ChatFlowEventEnvelope } from '@allrice/contracts';
import {
  workProcessQuestions,
  type WorkProcessAnswer,
} from './work-process-questions';

const session = 'dsh-00000000-0000-4000-8000-000000000001';
const questionId = `${session}:ask`;
function event(
  sequence: number,
  type: ChatFlowEventEnvelope['type'],
  payload: Record<string, unknown>,
  sourceType = 'session.event',
  source: Record<string, unknown> = {},
): ChatFlowEventEnvelope {
  return {
    schemaVersion: 3,
    eventId: `event-${sequence}`,
    organizationId: 'org',
    workspaceId: 'workspace',
    conversationId: 'conversation',
    runId: 'run',
    generation: 0,
    cursor: `run:${sequence}`,
    sequence,
    harness: 'dsh',
    type,
    occurredAt: '2026-11-10T00:00:00Z',
    payload,
    sourceEvent: {
      id: `native-${sequence}`,
      type: sourceType,
      occurredAt: '2026-11-10T00:00:00Z',
      payload: source,
    },
  };
}
const events = () => [
  event(1, 'tool.started', { toolCallId: 'ask', name: 'ask_user_question' }),
  event(
    2,
    'harness.native',
    { presentation: 'context', turnId: 'turn' },
    'session/user-question',
    {
      questionId,
      durable: true,
      nativeSessionId: session,
      callId: 'ask',
      questions: [{ id: 'sort', question: '按什么口径排序？' }],
    },
  ),
];
const answer: WorkProcessAnswer = {
  id: 'answer',
  answer: { questionId, answers: [{ id: 'sort', selected: [] }] },
  text: '排序：跳过',
  createdAt: '2026-11-10T00:00:00Z',
  status: 'adopted',
};

describe('native question ownership in the process', () => {
  it('embeds one exact accepted answer, including a native skipped answer', () => {
    const input = events();
    input.push(
      event(
        3,
        'harness.native',
        { presentation: 'context' },
        'session/user-question-answered',
        { questionId },
      ),
    );
    const original = structuredClone(input);
    const result = workProcessQuestions(
      [{ id: 'owner', events: input }],
      [answer],
    );
    expect([...result.embeddedAnswerIds]).toEqual(['answer']);
    expect(result.byOwner.get('owner')).toMatchObject([
      { callId: 'ask', pending: false, answered: true, answer },
    ]);
    expect(input).toEqual(original);
  });

  it('keeps pending and submitted facts separate without inferring acceptance', () => {
    const result = workProcessQuestions(
      [{ id: 'owner', events: events() }],
      [{ ...answer, status: 'pending' }],
    );
    expect(result.byOwner.get('owner')).toMatchObject([
      { pending: true, answered: false, answer: { status: 'pending' } },
    ]);
    expect(
      workProcessQuestions([{ id: 'owner', events: events() }], []).byOwner.get(
        'owner',
      )?.[0]?.answer,
    ).toBeUndefined();
  });

  it('retains answers at their original position for ambiguous owners, submissions or question items', () => {
    expect(
      workProcessQuestions(
        [
          { id: 'a', events: events() },
          { id: 'b', events: events() },
        ],
        [answer],
      ).embeddedAnswerIds.size,
    ).toBe(0);
    expect(
      workProcessQuestions(
        [{ id: 'a', events: events() }],
        [answer, { ...answer, id: 'retry' }],
      ).embeddedAnswerIds.size,
    ).toBe(0);
    expect(
      workProcessQuestions(
        [{ id: 'a', events: events() }],
        [
          {
            ...answer,
            answer: { questionId, answers: [{ id: 'other', selected: [] }] },
          },
        ],
      ).embeddedAnswerIds.size,
    ).toBe(0);
  });

  it('requires a schema-valid native session/call pair and the exact tool call', () => {
    const mismatched = events();
    mismatched[1]!.sourceEvent!.payload.nativeSessionId = `${session}-other`;
    expect(
      workProcessQuestions([{ id: 'owner', events: mismatched }], [answer])
        .embeddedAnswerIds.size,
    ).toBe(0);
    const missing = events();
    missing[0]!.payload.toolCallId = 'another-call';
    expect(
      workProcessQuestions([{ id: 'owner', events: missing }], [answer])
        .embeddedAnswerIds.size,
    ).toBe(0);
    expect(
      workProcessQuestions([{ id: 'owner', events: [] }], [answer])
        .embeddedAnswerIds.size,
    ).toBe(0);
  });

  it('does not attach an old answer to a later generation or a different exact question', () => {
    const next = event(3, 'tool.started', {
      toolCallId: 'ask',
      name: 'ask_user_question',
    });
    next.generation = 1;
    expect(
      workProcessQuestions(
        [{ id: 'owner', events: [...events(), next] }],
        [answer],
      ).embeddedAnswerIds.size,
    ).toBe(0);
    const other = {
      ...answer,
      answer: { ...answer.answer, questionId: `${session}-child:ask` },
    };
    expect(
      workProcessQuestions([{ id: 'owner', events: events() }], [other])
        .embeddedAnswerIds.size,
    ).toBe(0);
  });
});
