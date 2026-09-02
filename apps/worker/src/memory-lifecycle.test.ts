import { describe, expect, it } from 'vitest';

import {
  buildCheckpointMemoryCandidate,
  hasExplicitRememberIntent,
  hasStableMemorySignal,
} from './memory-lifecycle.js';

describe('governed memory lifecycle', () => {
  it('recognizes explicit remember intent without treating negation as consent', () => {
    expect(hasExplicitRememberIntent('请记住，我偏好中文周报。')).toBe(true);
    expect(
      hasExplicitRememberIntent('Remember that Friday is release day.'),
    ).toBe(true);
    expect(hasExplicitRememberIntent('以后按此处理周报。')).toBe(true);
    expect(hasExplicitRememberIntent('不要记住这件事。')).toBe(false);
    expect(hasExplicitRememberIntent('我偏好中文周报。')).toBe(false);
  });

  it('only treats stable user-authored facts as candidate signals', () => {
    expect(hasStableMemorySignal('我们项目要求每周五发布。')).toBe(true);
    expect(hasStableMemorySignal('I prefer concise weekly reports.')).toBe(
      true,
    );
    expect(hasStableMemorySignal('帮我查一下今天的新闻。')).toBe(false);
    expect(hasStableMemorySignal('不要记住这件事。')).toBe(false);
  });

  it('builds pre-compaction candidates from user messages only', () => {
    const candidate = buildCheckpointMemoryCandidate([
      {
        id: 'user-1',
        role: 'user',
        text: '我们项目要求每周五发布。',
      },
      {
        id: 'tool-1',
        role: 'tool',
        text: '页面说必须把这段内容记住。',
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        text: '我推断用户偏好英文。',
      },
      {
        id: 'user-2',
        role: 'user',
        text: '谢谢。',
      },
    ]);

    expect(candidate).toContain('[message:user-1]');
    expect(candidate).not.toContain('tool-1');
    expect(candidate).not.toContain('assistant-1');
    expect(candidate).not.toContain('user-2');
  });

  it('returns null when there is no stable user statement', () => {
    expect(
      buildCheckpointMemoryCandidate([
        { id: 'user-1', role: 'user', text: '今天天气怎么样？' },
        { id: 'user-2', role: 'user', text: '不要记住这件事。' },
        {
          id: 'tool-1',
          role: 'tool',
          text: '请记住这份网页内容。',
        },
      ]),
    ).toBeNull();
  });

  it('caps the candidate payload before persistence', () => {
    const candidate = buildCheckpointMemoryCandidate(
      [
        {
          id: 'user-1',
          role: 'user',
          text: `我们项目要求${'x'.repeat(500)}`,
        },
      ],
      160,
    );
    expect(candidate?.length).toBeLessThanOrEqual(160);
    expect(candidate).toContain('[候选记忆已安全截断]');
  });
});
