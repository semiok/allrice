import { describe, expect, it } from 'vitest';
import type { ChatFlowEventEnvelope } from '@allrice/contracts';
import {
  workProcessQuestions,
  type WorkProcessAnswer,
} from './work-process-questions';
import { questionAttemptFixture } from '../../test/work-process-question-attempt-fixture';
import {
  projectWorkProgress,
  currentWorkProgressEvents,
} from './work-progress';

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
  it.each([false, true])(
    'retains three exact answered calls across attempts with durable=%s',
    (durable) => {
      const f = questionAttemptFixture(durable);
      const resolve = (input = f.events, answers = f.answers) =>
        workProcessQuestions([{ id: 'owner', events: input }], answers);
      const result = resolve();
      expect([...result.embeddedAnswerIds]).toEqual(
        f.answers.map((answer) => answer.id),
      );
      expect(
        result.byOwner.get('owner')?.map((question) => question.request),
      ).toEqual(f.requests);
      expect(
        result.byOwner
          .get('owner')
          ?.every((question) => question.answered && !question.pending),
      ).toBe(true);
      const view = projectWorkProgress(f.events, 'fallback', false);
      expect(view.items.map((item) => item.id)).toEqual([
        'tool:ask-1',
        'tool:ask-2',
        'tool:ask-3',
      ]);
      expect(view.items[0]).toMatchObject({
        historicalQuestion: true,
        status: durable ? 'completed' : 'info',
      });
      const groups = view.parts!.filter((part) => part.kind === 'steps');
      expect(groups).toHaveLength(1);
      expect(groups[0]!.items.map((item) => item.id)).toEqual([
        'tool:ask-1',
        'tool:ask-2',
        'tool:ask-3',
      ]);
      expect(JSON.stringify(view)).not.toMatch(/OLD_ATTEMPT_BODY|old-read/);
      expect(view.finalText).toBe('本轮答题已记录。');
      expect(
        currentWorkProgressEvents(f.events).some(
          (event) => event.payload.attempt === 1,
        ),
      ).toBe(false);
      expect(resolve([...f.events, ...f.events]).byOwner.get('owner')).toEqual(
        result.byOwner.get('owner'),
      );
      expect([...resolve(f.liveTail).embeddedAnswerIds]).toEqual([
        f.answers[2]!.id,
      ]);
      expect(resolve().embeddedAnswerIds.size).toBe(3);
      if (durable) {
        expect(
          f.events.some(
            (event) =>
              event.sourceEvent?.type === 'session/user-question-answered',
          ),
        ).toBe(false);
        const foreground = f.events.find(
          (event) => event.sourceEvent?.type === 'session/user-questions',
        )!;
        const pending = f.events.find(
          (event) =>
            event.type === 'tool.completed' &&
            event.payload.toolCallId === 'ask-2',
        )!;
        expect(foreground.payload.attempt).toBe(1);
        expect(pending.payload.attempt).toBe(1);
        expect(pending.sourceEvent!.payload.message).toMatchObject({
          toolCallId: 'ask-2',
          content: [{ type: 'text', text: '{"pending":true}' }],
        });
        expect(foreground.sequence).toBeLessThan(pending.sequence);
        expect(
          resolve(f.events, [])
            .byOwner.get('owner')
            ?.every((question) => question.answered && !question.pending),
        ).toBe(true);
        const withoutCall = f.events.filter(
          (event) => event.payload.toolCallId !== 'ask-1',
        );
        expect([...resolve(withoutCall).embeddedAnswerIds]).toEqual(
          f.answers.map((answer) => answer.id),
        );
        expect(projectWorkProgress(withoutCall, '', false).items[0]?.id).toBe(
          'tool:ask-1',
        );
      }
    },
  );
  it.each(['missing', 'session', 'call', 'run', 'generation'])(
    'keeps the old timed answer outside without matching settled authority: %s',
    (mismatch) => {
      const f = questionAttemptFixture(true);
      const settled = structuredClone(
        f.events.find(
          (event) => event.sourceEvent?.type === 'session/user-questions',
        )!,
      );
      for (const event of f.events) {
        const questions = event.sourceEvent?.payload.questions;
        if (
          questions &&
          typeof questions === 'object' &&
          'settled' in questions &&
          Array.isArray(questions.settled)
        )
          questions.settled = questions.settled.filter(
            (question) => question.callId !== f.requests[0]!.callId,
          );
      }
      settled.eventId += '-mismatched';
      settled.sequence = f.events.at(-1)!.sequence + 1;
      if (mismatch === 'session')
        settled.sourceEvent!.payload.sessionId = 'another-session';
      if (mismatch === 'call')
        settled.sourceEvent!.payload.questions = {
          active: [],
          settled: [
            { callId: 'another-call', answers: f.answers[0]!.answer.answers },
          ],
        };
      if (mismatch === 'run') settled.runId = 'another-run';
      if (mismatch === 'generation') {
        settled.generation = 6;
        settled.payload.generation = 6;
      }
      if (mismatch !== 'missing') f.events.push(settled);
      const result = workProcessQuestions(
        [{ id: 'owner', events: f.events }],
        f.answers,
      );
      expect([...result.embeddedAnswerIds]).toEqual(
        f.answers.slice(1).map((answer) => answer.id),
      );
      expect(
        projectWorkProgress(f.events, '', false).items.map((item) => item.id),
      ).not.toContain('tool:ask-1');
    },
  );
  it('does not call a successful timed pending tool an answered question', () => {
    const f = questionAttemptFixture(true);
    const tail = f.liveTail.filter(
      (event) =>
        !['session/user-questions', 'run/end'].includes(
          event.sourceEvent?.type ?? '',
        ),
    );
    const result = tail.find((event) => event.type === 'tool.completed')!;
    result.sourceEvent!.payload.message = {
      toolCallId: 'ask-3',
      content: [{ type: 'text', text: '{"pending":true}' }],
    };
    const question = workProcessQuestions(
      [{ id: 'owner', events: tail }],
      [],
    ).byOwner.get('owner')![0]!;
    expect(question).toMatchObject({
      callId: 'ask-3',
      pending: true,
      answered: false,
    });
  });
  it('keeps independent native sessions when their call and question identities differ', () => {
    const f = questionAttemptFixture();
    const request = f.events.find(
      (event) => event.sourceEvent?.type === 'session/user-question',
    )!;
    request.sourceEvent!.payload.nativeSessionId = 'another-native-session';
    const result = workProcessQuestions(
      [{ id: 'owner', events: f.events }],
      f.answers,
    );
    expect(result.embeddedAnswerIds.size).toBe(3);
  });
  it.each([
    'run',
    'organization',
    'workspace',
    'generation',
    'call',
    'question',
    'missing-call',
  ])(
    'keeps the unproven old %s receipt in its original position',
    (mismatch) => {
      const f = questionAttemptFixture();
      const request = f.events.find(
        (event) => event.sourceEvent?.type === 'session/user-question',
      )!;
      const old = f.events.filter((event) => event.payload.attempt === 1);
      if (mismatch === 'run')
        old.forEach((event) => {
          event.runId = 'another-run';
        });
      if (mismatch === 'organization')
        old.forEach((event) => {
          event.organizationId = 'another-organization';
        });
      if (mismatch === 'workspace')
        old.forEach((event) => {
          event.workspaceId = 'another-workspace';
        });
      if (mismatch === 'generation')
        old.forEach((event) => {
          event.generation = 6;
          event.payload.generation = 6;
        });
      if (mismatch === 'call')
        request.sourceEvent!.payload.callId = 'different-call';
      if (mismatch === 'question')
        request.sourceEvent!.payload.questionId = 'different-question';
      if (mismatch === 'missing-call')
        delete request.sourceEvent!.payload.callId;
      const result = workProcessQuestions(
        [{ id: 'owner', events: f.events }],
        f.answers,
      );
      expect([...result.embeddedAnswerIds]).toEqual(
        f.answers.slice(1).map((answer) => answer.id),
      );
      expect(
        projectWorkProgress(f.events, '', false).items.map((item) => item.id),
      ).not.toContain('tool:ask-1');
    },
  );
  it.each(['session', 'call', 'request', 'answer', 'owner'])(
    'preserves conflicting or duplicated %s facts rather than choosing an owner',
    (conflict) => {
      const f = questionAttemptFixture();
      const request = f.events.find(
        (event) => event.sourceEvent?.type === 'session/user-question',
      )!;
      const duplicate = structuredClone(request);
      duplicate.eventId += '-conflict';
      duplicate.sequence = 10;
      duplicate.payload.attempt = 2;
      if (conflict === 'session')
        duplicate.sourceEvent!.payload.nativeSessionId =
          'another-native-session';
      if (conflict === 'call')
        duplicate.sourceEvent!.payload.callId = 'another-call';
      if (conflict === 'request')
        duplicate.sourceEvent!.payload.questions = [
          { id: 'different', question: '不同的题目' },
        ];
      const events = ['session', 'call', 'request'].includes(conflict)
        ? [...f.events, duplicate]
        : f.events;
      const owners = [
        { id: 'owner', events },
        ...(conflict === 'owner' ? [{ id: 'another-owner', events }] : []),
      ];
      const answers = [
        ...f.answers,
        ...(conflict === 'answer'
          ? [{ ...f.answers[0]!, id: 'duplicate-answer' }]
          : []),
      ];
      const result = workProcessQuestions(owners, answers);
      expect(result.embeddedAnswerIds.has(f.answers[0]!.id)).toBe(false);
      if (conflict !== 'owner') expect(result.embeddedAnswerIds.size).toBe(2);
      else expect(result.embeddedAnswerIds.size).toBe(0);
    },
  );
  it('embeds blocking answers only with the exact native call metadata and tool', () => {
    const input = events();
    input[1]!.sourceEvent!.payload = {
      ...input[1]!.sourceEvent!.payload,
      questionId: 'blocking-request',
      durable: false,
    };
    const accepted = {
      ...answer,
      answer: { ...answer.answer, questionId: 'blocking-request' },
    };
    const resolve = () =>
      workProcessQuestions([{ id: 'owner', events: input }], [accepted]);
    expect([...resolve().embeddedAnswerIds]).toEqual(['answer']);
    expect(resolve().byOwner.get('owner')?.[0]?.request.durable).toBe(false);
    input[0]!.payload.toolCallId = 'different-call';
    expect(resolve().embeddedAnswerIds.size).toBe(0);
    input[0]!.payload.toolCallId = 'ask';
    delete input[1]!.sourceEvent!.payload.nativeSessionId;
    expect(resolve().embeddedAnswerIds.size).toBe(0);
  });
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

  it('requires a schema-valid native session/call pair, including a durable request before its call trace', () => {
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
    ).toBe(1);
    expect(
      workProcessQuestions([{ id: 'owner', events: [events()[1]!] }], [answer])
        .embeddedAnswerIds.size,
    ).toBe(1);
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
