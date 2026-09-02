import { describe, expect, it } from 'vitest';

import type { ChatFlowEventEnvelope } from '@allrice/contracts';

import { projectPendingUserQuestion } from './user-question-state';

function event(
  sequence: number,
  sourceType: string,
  sourcePayload: Record<string, unknown>,
): ChatFlowEventEnvelope {
  return {
    schemaVersion: 3,
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    organizationId: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    conversationId: '00000000-0000-4000-8000-000000000003',
    runId: '00000000-0000-4000-8000-000000000004',
    generation: 2,
    cursor: `cursor-${sequence}`,
    sequence,
    harness: 'dsh',
    type: 'harness.native',
    occurredAt: new Date(sequence * 1_000).toISOString(),
    sourceEvent: {
      id: `dsh:${sequence}`,
      type: sourceType,
      occurredAt: new Date(sequence * 1_000).toISOString(),
      payload: sourcePayload,
    },
    payload: {
      source: 'dsh',
      generation: 2,
      turnId: 'turn-2',
      presentation: 'context',
      status: 'started',
      label: 'Rice 需要你确认',
    },
  };
}

describe('projectPendingUserQuestion', () => {
  it('retains the complete native question request until DSH resolves it', () => {
    const asked = event(1, 'session/user-question', {
      questionId: 'question-1',
      questions: [
        {
          id: 'format',
          question: '你希望生成哪一种？',
          options: [
            { label: 'xlsx (Recommended)', description: '保留格式' },
            { label: 'csv', description: '通用文本' },
          ],
          multiSelect: false,
        },
      ],
    });

    expect(projectPendingUserQuestion([asked])).toMatchObject({
      questionId: 'question-1',
      generation: 2,
      turnId: 'turn-2',
      questions: [{ id: 'format', options: expect.any(Array) }],
    });
    expect(
      projectPendingUserQuestion([
        asked,
        event(2, 'session/user-question-answered', {
          questionId: 'question-1',
        }),
      ]),
    ).toBeNull();
  });

  it('ignores legacy summary-only events that cannot be answered safely', () => {
    expect(
      projectPendingUserQuestion([
        event(1, 'session/user-question', { questionCount: 1 }),
      ]),
    ).toBeNull();
  });
});
