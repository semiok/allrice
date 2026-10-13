import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { ContextCheckpoint } from '@allrice/contracts';

import {
  assembleEmployeeKernel,
  bootstrapConversationForCheckpoint,
} from './employee-kernel.js';

it('assembles each frozen common rule once and rejects conflicting implicit versions before a model call', () => {
  const assetId = randomUUID(),
    revisionId = randomUUID(),
    digest = `sha256:${'a'.repeat(64)}`;
  const input = {
    employeeAssignmentId: randomUUID(),
    employeeVersionId: randomUUID(),
    sessionId: randomUUID(),
    userMessageId: randomUUID(),
    assistantMessageId: randomUUID(),
    commonContent: [
      {
        reference: {
          sourceKind: 'company_rule',
          contentId: assetId,
          revisionId,
          digest,
        },
        available: true,
        title: 'Common',
        body: 'RULE_BODY_42',
      },
    ],
    resolved: {
      promptSnapshot: {
        systemPrompt: 'Platform',
        userRequest: 'Request',
        conversation: [],
        memories: [],
        companyAssets: {
          templates: [],
          rules: [
            {
              assetId,
              revision: {
                id: revisionId,
                digest,
                content: { title: 'Common', body: 'RULE_BODY_42' },
              },
            },
          ],
        },
      },
      executionSnapshot: null,
      grantedCapabilities: ['model:invoke'],
      nativeSkills: [],
    },
  } as unknown as Parameters<typeof assembleEmployeeKernel>[0];
  expect(
    assembleEmployeeKernel(input).systemInstructions.match(/RULE_BODY_42/g),
  ).toHaveLength(1);
  input.resolved.promptSnapshot.companyAssets!.rules[0]!.revision.id =
    randomUUID();
  expect(() => assembleEmployeeKernel(input)).toThrow(
    '共同要求与本次引用的规则版本不一致',
  );
});

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
