import { describe, expect, it } from 'vitest';

import type { ContextCheckpoint } from '@allrice/contracts';

import { bootstrapConversationForCheckpoint } from './employee-kernel.js';

describe('Employee Kernel checkpoint recovery', () => {
  it('injects a verified checkpoint and only the uncovered message window', () => {
    const checkpoint = {
      summaryVersion: 'extractive-v1',
      generation: 3,
      coveredThroughMessageId: '00000000-0000-4000-8000-000000000002',
      summary: '目标：完成框架升级；决定：先使用 Codex Adapter。',
    } as ContextCheckpoint;
    const bootstrap = bootstrapConversationForCheckpoint(
      [
        {
          id: '00000000-0000-4000-8000-000000000001',
          role: 'user',
          text: '旧消息',
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          role: 'assistant',
          text: '已覆盖消息',
        },
        {
          id: '00000000-0000-4000-8000-000000000003',
          role: 'user',
          text: '继续做流式输出',
        },
      ],
      checkpoint,
    );
    expect(bootstrap).toContain('目标：完成框架升级');
    expect(bootstrap).toContain('继续做流式输出');
    expect(bootstrap).not.toContain('旧消息');
    expect(bootstrap).not.toContain('已覆盖消息');
  });
});
