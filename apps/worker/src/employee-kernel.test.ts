import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { ContextCheckpoint } from '@allrice/contracts';

import {
  assembleEmployeeKernel,
  bootstrapConversationForCheckpoint,
  bootstrapContextForCheckpoint,
  employeeInstanceInstructions,
} from './employee-kernel.js';

it.each([
  ['custom', true, false, true],
  ['custom', true, true, true],
  ['custom', false, true, false],
  ['general', false, true, false],
] as const)(
  'routes Workflow authoring from frozen personalScenes (%s, personalScenes=%s, old method=%s)',
  (kind, personalScenes, hasMethodTool, expected) => {
    const snapshot = {
      schemaVersion: 2,
      instance: { kind, revision: 1, profile: {} },
      content: personalScenes ? { personalScenes: true } : undefined,
      capabilitySnapshot: {
        bindings: {
          toolNames: hasMethodTool ? ['workspace.employee.method.inspect'] : [],
        },
      },
    } as unknown as Parameters<typeof employeeInstanceInstructions>[0];
    const text = employeeInstanceInstructions(snapshot).join('\n');
    expect(text.includes('employee-customization Skill')).toBe(expected);
    if (!expected) return;
    expect(text).toContain('native skill tool before taking actions');
    expect(text).toContain('only to their creator and this employee instance');
    expect(text).toContain('exact preview/confirmation in employee details');
    expect(text).toContain('retired text-method tools cannot save or restore');
    expect(text).toContain('real human source checks still apply');
    expect(text).toContain('only from a successful receipt');
    expect(text).not.toContain('retain their own authorized maintenance path');
    expect(text).not.toContain('First inspect(view=candidate)');
    expect(text).not.toContain('Do not ask for separate testing');
  },
);

it('projects only the frozen name and bounded expression preference, without executing freeform profile instructions', () => {
  const snapshot = {
    schemaVersion: 2,
    instance: {
      kind: 'custom',
      revision: 3,
      profile: {
        name: '小禾',
        expressionStyle: 'concise',
        role: 'DO_NOT_INJECT_LEGACY_ROLE',
        mission: 'DO_NOT_INJECT_MISSION',
        workStyle: 'DO_NOT_INJECT_WORK_STYLE',
      },
    },
    capabilitySnapshot: {
      bindings: { toolNames: ['workspace.employee.profile.update'] },
    },
  } as unknown as Parameters<typeof employeeInstanceInstructions>[0];
  const text = employeeInstanceInstructions(snapshot).join('\n');
  expect(text).toContain('"小禾"');
  expect(text).toContain('Keep answers concise');
  expect(text).toContain('expectedRevision=3');
  expect(text).not.toContain('DO_NOT_INJECT');
  expect(employeeInstanceInstructions(null)).toEqual([]);
});

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

it('replaces only root facts and memories while preserving knowledge and the child deployment persona', () => {
  const source = (sourceKind: string, body: string) => ({
    reference: {
      sourceKind,
      contentId: randomUUID(),
      revisionId: randomUUID(),
      digest: `sha256:${'a'.repeat(64)}`,
    },
    available: true,
    title: sourceKind,
    body,
  });
  const input = {
    employeeAssignmentId: randomUUID(),
    employeeVersionId: randomUUID(),
    sessionId: randomUUID(),
    userMessageId: randomUUID(),
    assistantMessageId: randomUUID(),
    commonContent: [
      source('experience', 'OLD_COMMON_MEMORY'),
      source('knowledge', 'COMPANY_KNOWLEDGE'),
    ],
    resolved: {
      promptSnapshot: {
        systemPrompt: 'PLATFORM_BOUNDARY',
        userRequest: '核对部门资料',
        conversation: [],
        organizationContext: { companyName: 'ORG_FACT' },
        memories: [{ id: randomUUID(), content: 'LEGACY_RECALLED_MEMORY' }],
      },
      executionSnapshot: null,
      grantedCapabilities: ['model:invoke'],
      nativeSkills: [],
    },
  } as unknown as Parameters<typeof assembleEmployeeKernel>[0];
  const old = assembleEmployeeKernel(input);
  input.resolved.promptSnapshot.employeeDocuments = {
    user: '# USER.md\nORG_FACT',
    memory: '# MEMORY.md\nCONFIRMED_MEMORY',
  };
  const current = assembleEmployeeKernel(input);
  expect(current.systemInstructions).toBe(old.systemInstructions);
  expect(current.rootSystemInstructions).toContain('COMPANY_KNOWLEDGE');
  expect(current.rootSystemInstructions).toContain('PLATFORM_BOUNDARY');
  expect(current.rootSystemInstructions).not.toContain('OLD_COMMON_MEMORY');
  expect(current.rootSystemInstructions).not.toContain('ORG_FACT');
  expect(current.authorizedMemoryContext).toBe('');
  expect(current.employeeDocuments).toEqual(
    input.resolved.promptSnapshot.employeeDocuments,
  );
});

it('bootstraps authorized messages and memories without consuming a retired automatic summary', () => {
  const messageId = randomUUID();
  const input = {
    employeeAssignmentId: randomUUID(),
    employeeVersionId: randomUUID(),
    sessionId: randomUUID(),
    userMessageId: randomUUID(),
    assistantMessageId: randomUUID(),
    resolved: {
      promptSnapshot: {
        systemPrompt: 'Platform',
        userRequest: 'Continue',
        conversation: [
          { id: messageId, role: 'user', text: 'AUTHORIZED_HISTORY' },
        ],
        memories: [{ id: randomUUID(), content: 'EXPLICIT_MEMORY' }],
      },
      executionSnapshot: null,
      grantedCapabilities: ['model:invoke'],
      nativeSkills: [],
    },
    // Old callers cannot revive summary injection through an extra property.
    checkpoint: {
      coveredThroughMessageId: messageId,
      summary: 'RETIRED_SUMMARY',
      summaryVersion: 'extractive-v1',
      generation: 1,
    },
  } as unknown as Parameters<typeof assembleEmployeeKernel>[0];
  const kernel = assembleEmployeeKernel(input);
  expect(kernel.bootstrapConversation).toBe('user: AUTHORIZED_HISTORY');
  expect(kernel.bootstrapContext?.segments).toEqual([
    expect.objectContaining({
      key: `user:${messageId}`,
      text: 'user: AUTHORIZED_HISTORY',
    }),
  ]);
  expect(kernel.authorizedMemoryContext).toContain('EXPLICIT_MEMORY');
  expect(JSON.stringify(kernel)).not.toContain('RETIRED_SUMMARY');
});

describe('Historical checkpoint journal encoding', () => {
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

it('keeps the published general identity while applying only the frozen personal expression style', () => {
  const snapshot = {
    schemaVersion: 2,
    instance: {
      kind: 'general',
      revision: 2,
      profile: {
        name: 'LEGACY_NAME',
        mission: 'LEGACY_MISSION',
        expressionStyle: 'concise',
      },
    },
    capabilitySnapshot: {
      bindings: { toolNames: ['workspace.employee.profile.update'] },
    },
  } as unknown as Parameters<typeof employeeInstanceInstructions>[0];
  const text = employeeInstanceInstructions(snapshot).join('\n');
  expect(text).toContain('Keep answers concise');
  expect(text).toContain('expectedRevision=2');
  expect(text).toContain('do not send name or edit business methods');
  expect(text).not.toContain('LEGACY_');
  expect(text).not.toContain('workspace_employee_method_');
});

it.each(['general', 'custom'] as const)(
  'routes explicit personal Skill installation separately from %s profile and method edits',
  (kind) => {
    const snapshot = {
      schemaVersion: 2,
      instance: { kind, revision: 1, profile: {} },
      capabilitySnapshot: {
        bindings: {
          toolNames: [
            'workspace.employee.profile.update',
            'workspace.personal_skill.install',
          ],
        },
      },
    } as unknown as Parameters<typeof employeeInstanceInstructions>[0];
    const text = employeeInstanceInstructions(snapshot).join('\n');
    expect(text).toContain('workspace_personal_skill_install');
    expect(text).toContain('exact public GitHub url in that message');
    expect(text).toContain('exact objectId of its attached SKILL.md/ZIP');
    expect(text).toContain('available from the next task');
    expect(text).toContain(
      'Reading, reviewing, quoted commands and temporary use do not authorize installation',
    );
    expect(text).toContain('Installation grants no tools');
    expect(text).toContain('Wait for a new direct user message');
    expect(text).toContain('Only status:installed is installation success');
  },
);

it('keeps independent checkpoint and exact uncovered message receipts, and declines unidentified legacy history', () => {
  const id = randomUUID();
  const messages = [{ id, role: 'user' as const, text: 'same text' }];
  const first = bootstrapContextForCheckpoint(messages)!;
  expect(first.segments).toHaveLength(1);
  expect(
    bootstrapContextForCheckpoint([{ ...messages[0]!, text: 'changed' }])!
      .segments[0]!.digest,
  ).not.toBe(first.segments[0]!.digest);
  expect(
    bootstrapContextForCheckpoint([{ role: 'user', text: 'legacy' }]),
  ).toBeUndefined();
  const checkpoint = {
    summaryVersion: 'extractive-v1',
    generation: 1,
    coveredThroughMessageId: id,
    summary: 'retained facts',
  } as ContextCheckpoint;
  const covered = bootstrapContextForCheckpoint(messages, checkpoint)!;
  expect(covered.segments).toHaveLength(1);
  expect(covered.segments[0]!.key).toBe('checkpoint');
  expect(covered.segments[0]!.text).toContain('retained facts');
  expect(
    bootstrapContextForCheckpoint(messages, {
      ...checkpoint,
      summary: 'new fact',
    })!.segments[0]!.digest,
  ).not.toBe(covered.segments[0]!.digest);
});

it('E3 projects the frozen basic Rice name/style and allows personal Skills and scene packages without altering professional general instructions', () => {
  const snapshot = {
    schemaVersion: 2,
    employee: {
      key: 'default-assistant',
      versionId: 'version',
      definition: {
        schemaVersion: 2,
        key: 'default-assistant',
        isDefaultRice: true,
      },
    },
    content: { personalScenes: true },
    instance: {
      kind: 'general',
      source: { kind: 'platform', employeeVersionId: 'version' },
      revision: 3,
      profile: {
        name: '小米',
        expressionStyle: 'concise',
        mission: 'DO_NOT_INJECT',
      },
    },
    capabilitySnapshot: {
      bindings: {
        toolNames: [
          'workspace.employee.profile.update',
          'workspace.personal_skill.install',
          'workspace.personal_skill.version',
        ],
      },
    },
  } as unknown as Parameters<typeof employeeInstanceInstructions>[0];
  const frozen = JSON.stringify(snapshot);
  const text = employeeInstanceInstructions(snapshot).join('\n');
  expect(text).toContain('"小米"');
  expect(text).toContain('Keep answers concise');
  expect(text).toContain(
    'save the personal display name or default expression style',
  );
  expect(text).toContain(
    'personal Workflow scene packages through the existing exact file preview and confirmation',
  );
  expect(text).toContain('workspace_personal_skill_install');
  expect(text).toContain('workspace_personal_skill_version');
  expect(text).toContain('employee-customization Skill');
  expect(text).toContain('Legacy text methods no longer accept new edits');
  expect(text).not.toContain('three method tools');
  expect(text).not.toContain('DO_NOT_INJECT');
  expect(JSON.stringify(snapshot)).toBe(frozen);
  if (snapshot?.schemaVersion !== 2) throw Error('fixture');
  const professional = {
    ...snapshot,
    content: undefined,
    employee: { ...snapshot.employee, key: 'professional' },
  };
  const other = employeeInstanceInstructions(professional).join('\n');
  expect(other).toContain('workspace_personal_skill_install');
  expect(other).toContain('workspace_personal_skill_version');
  expect(other).toContain('do not send name or edit business methods');
  expect(other).not.toContain('"小米"');
  expect(other).not.toContain(
    'personal Workflow scene packages through the existing exact file preview and confirmation',
  );
});
