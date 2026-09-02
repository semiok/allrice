import { describe, expect, it } from 'vitest';

import {
  applyWorkspaceMemoryRecallBudget,
  embedWorkspaceText,
  rankWorkspaceMemoryRecallCandidates,
} from './workspace.js';

describe('employee workspace embedding', () => {
  it('is deterministic, normalized and sensitive to text', () => {
    const first = embedWorkspaceText('AllRice remembers tenant-safe context');
    const retry = embedWorkspaceText('AllRice remembers tenant-safe context');
    const different = embedWorkspaceText('A different memory source');

    expect(first).toHaveLength(1536);
    expect(retry).toEqual(first);
    expect(different).not.toEqual(first);
    expect(Math.hypot(...first)).toBeCloseTo(1, 10);
  });
});

const memoryBase = {
  sourceType: 'checkpoint' as const,
  sourceId: '11111111-1111-4111-8111-111111111111',
  lifecycleState: 'durable' as const,
  memoryClass: 'work_note' as const,
  trust: 'derived' as const,
  confidence: 0.8,
  sourceLabel: 'checkpoint',
  capturedAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

describe('workspace memory hybrid recall', () => {
  it('excludes candidates from automatic recall and filters by relevance threshold', () => {
    const ranked = rankWorkspaceMemoryRecallCandidates(
      [
        {
          ...memoryBase,
          id: '22222222-2222-4222-8222-222222222222',
          content: '项目使用 PostgreSQL 保存记忆',
          lifecycleState: 'candidate',
          vectorScore: 0.99,
          lexicalScore: 1,
        },
        {
          ...memoryBase,
          id: '33333333-3333-4333-8333-333333333333',
          content: '团队决定使用 PostgreSQL 作为唯一记忆源',
          memoryClass: 'decision',
          trust: 'user_confirmed',
          confidence: 1,
          vectorScore: 0.9,
          lexicalScore: 0.92,
        },
        {
          ...memoryBase,
          id: '44444444-4444-4444-8444-444444444444',
          content: '完全无关的午餐记录',
          vectorScore: 0.01,
          lexicalScore: 0,
        },
      ],
      {
        threshold: 0.28,
        limit: 3,
        durableOnly: true,
        now: new Date('2026-09-01T00:00:00.000Z'),
      },
    );

    expect(ranked.map((candidate) => candidate.id)).toEqual([
      '33333333-3333-4333-8333-333333333333',
    ]);
  });

  it('can recall a paraphrase through the lexical channel when vectors are weak', () => {
    const ranked = rankWorkspaceMemoryRecallCandidates(
      [
        {
          ...memoryBase,
          id: '99999999-9999-4999-8999-999999999999',
          content: '用户偏好使用中文撰写每周项目报告',
          memoryClass: 'user_preference',
          trust: 'user_confirmed',
          confidence: 1,
          vectorScore: 0.02,
          lexicalScore: 0.31,
        },
      ],
      {
        threshold: 0.28,
        limit: 3,
        durableOnly: true,
        now: new Date('2026-09-01T00:00:00.000Z'),
      },
    );

    expect(ranked.map((candidate) => candidate.id)).toEqual([
      '99999999-9999-4999-8999-999999999999',
    ]);
  });

  it('deduplicates normalized content and applies an injection budget', () => {
    const ranked = rankWorkspaceMemoryRecallCandidates(
      [
        {
          ...memoryBase,
          id: '55555555-5555-4555-8555-555555555555',
          content: '用户偏好中文报告',
          vectorScore: 0.9,
          lexicalScore: 0.8,
        },
        {
          ...memoryBase,
          id: '66666666-6666-4666-8666-666666666666',
          content: '  用户偏好中文报告  ',
          vectorScore: 0.8,
          lexicalScore: 0.7,
        },
      ],
      {
        threshold: 0.28,
        limit: 3,
        durableOnly: true,
        now: new Date('2026-09-01T00:00:00.000Z'),
      },
    );
    expect(ranked).toHaveLength(1);

    const budgeted = applyWorkspaceMemoryRecallBudget(
      [{ ...ranked[0]!, content: '记'.repeat(1_000) }],
      100,
    );
    expect(budgeted).toHaveLength(1);
    expect(budgeted[0]!.content.length).toBeLessThanOrEqual(400);
    expect(budgeted[0]!.content).toContain('记忆内容已按预算截断');
  });
});
