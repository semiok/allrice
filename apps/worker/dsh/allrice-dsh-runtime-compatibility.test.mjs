import { describe, expect, it } from 'vitest';

import {
  steerDshAgent,
  structuredUserQuestionAnswer,
} from './allrice-dsh-runtime-compatibility.mjs';

describe('AllRice DSH runtime compatibility', () => {
  it('creates and submits one upstream user message for steering', () => {
    const messages = [];
    const messageId = steerDshAgent(
      {
        steer(message) {
          messages.push(message);
        },
      },
      'Continue with the revised scope.',
    );

    expect(messageId).toEqual(expect.any(String));
    expect(messageId).not.toHaveLength(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: messageId,
      role: 'user',
      content: [{ type: 'text', text: 'Continue with the revised scope.' }],
      source: { kind: 'user' },
    });
  });

  it('validates a complete structured answer against the pending question batch', () => {
    const pending = {
      questionId: 'question-1',
      questions: [
        {
          id: 'format',
          question: 'Choose a format',
          options: [{ label: 'xlsx' }, { label: 'csv' }],
          multiSelect: false,
        },
        {
          id: 'extras',
          question: 'Choose extras',
          options: [{ label: 'chart' }, { label: 'summary' }],
          multiSelect: true,
        },
      ],
    };
    expect(
      structuredUserQuestionAnswer(
        pending,
        `allrice:user-question:v1:${JSON.stringify({
          questionId: 'question-1',
          answers: [
            { id: 'format', selected: ['xlsx'] },
            { id: 'extras', selected: ['chart'], custom: 'include sources' },
          ],
        })}`,
      ),
    ).toEqual({
      answers: [
        { id: 'format', selected: ['xlsx'] },
        { id: 'extras', selected: ['chart'], custom: 'include sources' },
      ],
    });
  });

  it('rejects a structured answer for another pending request', () => {
    expect(() =>
      structuredUserQuestionAnswer(
        {
          questionId: 'question-1',
          questions: [{ id: 'format', options: [{ label: 'xlsx' }] }],
        },
        'allrice:user-question:v1:{"questionId":"question-2","answers":[]}',
      ),
    ).toThrow('does not match');
  });
});
