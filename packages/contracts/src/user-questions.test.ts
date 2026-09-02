import { describe, expect, it } from 'vitest';

import {
  ChatMessageContentSchema,
  SendChatMessageInputSchema,
  UserQuestionRequestSchema,
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
});
