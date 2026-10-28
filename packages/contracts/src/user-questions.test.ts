import { describe, expect, it } from 'vitest';

import {
  ChatMessageContentSchema,
  RuntimeNativeInputProofSchema,
  SendChatMessageInputSchema,
  UserQuestionRequestSchema,
  matchUserQuestionAnswer,
} from './index.js';

describe('user question contracts', () => {
  it('preserves the complete DSH question shape', () => {
    expect(
      UserQuestionRequestSchema.parse({
        questionId: 'question-1',
        questions: [
          {
            id: 'format',
            header: '选择格式',
            question: '你希望生成哪一种？',
            options: [
              {
                label: 'xlsx (Recommended)',
                description: '保留公式和格式',
              },
            ],
            multiSelect: false,
          },
        ],
      }),
    ).toMatchObject({
      questionId: 'question-1',
      questions: [{ id: 'format', multiSelect: false }],
    });
  });

  it.each([
    '',
    '-00000000-0000-4000-8000-000000000002',
    '-00000000-0000-4000-8000-000000000002-00000000-0000-4000-8000-000000000003',
  ])(
    'preserves full native identity with context %s beyond legacy limits',
    (context) => {
      const questionId = `dsh-00000000-0000-4000-8000-000000000001${context}:${'call:'.repeat(80)}`;
      expect(
        UserQuestionRequestSchema.parse({
          questionId,
          questions: [{ id: 'q', question: '继续？' }],
        }).questionId,
      ).toBe(questionId);
      expect(
        UserQuestionRequestSchema.safeParse({
          questionId: 'x'.repeat(241),
          questions: [{ id: 'q', question: '继续？' }],
        }).success,
      ).toBe(false);
      expect(
        RuntimeNativeInputProofSchema.parse({
          status: 'adopted',
          inputId: '00000000-0000-4000-8000-000000000001',
          messageId: questionId,
          callId: 'call:'.repeat(80),
          sequence: 10,
          turnId: 'turn:2',
          checkpoint: 'question_replied',
        }).messageId,
      ).toBe(questionId);
    },
  );

  it('checks the complete Session/call identity without splitting call IDs on colons', () => {
    const request = {
      questionId: 'session:call:with:colons',
      nativeSessionId: 'session',
      callId: 'call:with:colons',
      durable: true,
      questions: [{ id: 'q', question: '继续？' }],
    };
    expect(UserQuestionRequestSchema.safeParse(request).success).toBe(true);
    for (const patch of [
      { questionId: 'other' },
      { nativeSessionId: 'other' },
      { callId: 'other' },
    ])
      expect(
        UserQuestionRequestSchema.safeParse({ ...request, ...patch }).success,
      ).toBe(false);
  });

  it('requires structured answers to target an exact active turn', () => {
    const common = {
      clientMessageId: '00000000-0000-4000-8000-000000000001',
      text: '选择格式：xlsx',
      attachmentIds: [],
      userQuestionAnswer: {
        questionId: 'question-1',
        answers: [{ id: 'format', selected: ['xlsx'] }],
      },
    };
    expect(
      SendChatMessageInputSchema.safeParse({
        ...common,
        deliveryMode: 'auto',
      }).success,
    ).toBe(false);
    expect(
      SendChatMessageInputSchema.safeParse({
        ...common,
        deliveryMode: 'steer',
        expectedTurnId: 'turn-1',
        expectedGeneration: 2,
      }).success,
    ).toBe(true);
  });

  it('preserves a user question answer as message presentation metadata', () => {
    expect(
      ChatMessageContentSchema.parse({
        text: '文件格式：xlsm (Recommended)',
        interaction: {
          type: 'user_question_answer',
          answer: {
            questionId: 'question-1',
            answers: [{ id: 'format', selected: ['xlsm (Recommended)'] }],
          },
        },
      }),
    ).toMatchObject({
      interaction: {
        type: 'user_question_answer',
        answer: { questionId: 'question-1' },
      },
    });
  });
  it('admits a native Session question without a live turn while preserving attachment and ordinary-steer fences', () => {
    const input = {
      clientMessageId: '00000000-0000-4000-8000-000000000001',
      text: '跳过本题',
      userQuestionAnswer: {
        questionId: 'dsh-00000000-0000-4000-8000-000000000001:call:1',
        answers: [{ id: 'q', selected: [] }],
      },
    };
    for (const deliveryMode of ['auto', 'follow_up', 'steer'])
      expect(
        SendChatMessageInputSchema.safeParse({ ...input, deliveryMode })
          .success,
      ).toBe(true);
    expect(
      SendChatMessageInputSchema.safeParse({
        ...input,
        attachmentIds: ['00000000-0000-4000-8000-000000000002'],
      }).success,
    ).toBe(false);
    expect(
      SendChatMessageInputSchema.safeParse({
        ...input,
        userQuestionAnswer: undefined,
        deliveryMode: 'steer',
      }).success,
    ).toBe(false);
  });
});

// MET-210: the one answer rule shared by the native input, the parked wait
// and resume. It follows DSH: each question exactly once, skips are answers.
describe('matchUserQuestionAnswer', () => {
  const request = {
    questionId: 'q',
    questions: [
      { id: 'one', options: [{ label: 'A' }, { label: 'B' }] },
      {
        id: 'many',
        multiSelect: true,
        options: [{ label: 'X' }, { label: 'Y' }],
      },
    ],
  };
  const answer = (...answers: unknown[]) => ({ questionId: 'q', answers });
  it.each([
    [
      'both skipped',
      answer({ id: 'one', selected: [] }, { id: 'many', selected: [] }),
    ],
    [
      'partly skipped',
      answer({ id: 'many', selected: ['X', 'Y'] }, { id: 'one', selected: [] }),
    ],
    [
      'custom text alone',
      answer(
        { id: 'one', selected: [], custom: '都行' },
        { id: 'many', selected: [] },
      ),
    ],
    [
      'labels plus custom on a multi-select',
      answer(
        { id: 'one', selected: ['A'] },
        { id: 'many', selected: ['X'], custom: '还有 Z' },
      ),
    ],
  ])(
    'accepts %s and returns the answers in question order',
    (_case, submission) => {
      const matched = matchUserQuestionAnswer(request, submission);
      expect(matched?.answers.map((a) => a.id)).toEqual(['one', 'many']);
    },
  );
  it.each([
    [
      'another question',
      {
        ...answer({ id: 'one', selected: [] }, { id: 'many', selected: [] }),
        questionId: 'other',
      },
    ],
    ['a missing item', answer({ id: 'one', selected: [] })],
    [
      'a repeated item',
      answer({ id: 'one', selected: [] }, { id: 'one', selected: [] }),
    ],
    [
      'an unknown item',
      answer({ id: 'one', selected: [] }, { id: 'other', selected: [] }),
    ],
    [
      'an unknown option',
      answer({ id: 'one', selected: ['C'] }, { id: 'many', selected: [] }),
    ],
    [
      'a repeated option',
      answer({ id: 'one', selected: [] }, { id: 'many', selected: ['X', 'X'] }),
    ],
    [
      'two labels on a single-select',
      answer({ id: 'one', selected: ['A', 'B'] }, { id: 'many', selected: [] }),
    ],
    [
      'a label plus custom on a single-select',
      answer(
        { id: 'one', selected: ['A'], custom: 'x' },
        { id: 'many', selected: [] },
      ),
    ],
    ['a malformed batch', { questionId: 'q', answers: 'A' }],
  ])('rejects %s', (_case, submission) => {
    expect(matchUserQuestionAnswer(request, submission)).toBeNull();
  });
});
