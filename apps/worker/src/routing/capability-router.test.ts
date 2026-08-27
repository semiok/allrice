import { randomUUID } from 'node:crypto';

import {
  EmployeeExecutionSnapshotSchema,
  type EmployeeExecutionSnapshot,
  type RouteRequest,
} from '@allrice/contracts';
import { describe, expect, it } from 'vitest';

import { decideCapabilityRoute } from './capability-router.js';

function base(input?: {
  approvalPolicy?: 'confirm_side_effects' | 'confirm_external' | 'autonomous';
  connectorIdentityModes?: ('user' | 'service')[];
}) {
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const actorId = randomUUID();
  const employeeId = randomUUID();
  const now = '2026-08-25T00:00:00.000Z';
  const definition = {
    schemaVersion: 2 as const,
    key: 'rice',
    name: 'Rice',
    description: 'General employee',
    appearance: { avatarType: 'initials' as const, avatarValue: 'R' },
    applicableScenarios: [],
    isDefaultRice: true,
    identity: {
      role: '通用员工',
      mission: '完成工作',
      workStyle: '结构化',
      behaviorRules: [],
      safetyBoundaries: [],
    },
    systemPrompt: 'You are Rice.',
    provider: {
      provider: 'codex' as const,
      authMode: 'chatgpt_subscription' as const,
      model: 'gpt-5.6-luna',
      reasoningEffort: 'high' as const,
      sandbox: 'workspace-write' as const,
    },
    runtimePolicy: {
      harness: 'codex' as const,
      provider: 'codex',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'high' as const,
      timeoutMs: 300_000,
      fallbackModels: [],
    },
    capabilities: [
      'model:invoke',
      'storage:read',
      'network:outbound',
      'automation:write',
    ] as const,
    skillVersionIds: [],
    capabilityBindings: {
      skillVersionIds: [],
      toolNames: [
        'workspace.file.read',
        'web.search',
        'web.fetch',
        'automation.create',
      ],
      knowledgeScopes: ['workspace' as const],
      workflowIds: [],
    },
    securityPolicy: {
      dataScopes: ['workspace' as const, 'user' as const],
      connectorIdentityModes: input?.connectorIdentityModes ?? [
        'user' as const,
      ],
      approvalPolicy: input?.approvalPolicy ?? 'confirm_side_effects',
      deniedCapabilities: [],
    },
    userProfilePolicy: {
      enabled: true,
      fields: ['displayName' as const],
      scope: 'employee_user' as const,
    },
    partnerProfile: {
      role: '通用员工',
      mission: '完成工作',
      communicationStyle: 'structured' as const,
      outputLanguage: 'zh-CN' as const,
      proactivePolicy: 'suggest' as const,
      approvalPolicy: input?.approvalPolicy ?? 'confirm_side_effects',
    },
  };
  const snapshot = EmployeeExecutionSnapshotSchema.parse({
    schemaVersion: 2,
    employee: {
      id: employeeId,
      key: 'rice',
      versionId: randomUUID(),
      revision: 1,
      definitionChecksum: `sha256:${'a'.repeat(64)}`,
      definition,
    },
    assignment: {
      id: randomUUID(),
      userId: actorId,
      assignedBy: actorId,
      assignedAt: now,
    },
    runtimePolicy: definition.runtimePolicy,
    capabilitySnapshot: {
      declaredCapabilities: [...definition.capabilities],
      grantedCapabilities: [...definition.capabilities],
      bindings: definition.capabilityBindings,
      skillBindings: [],
      agentSkills: [],
      workflows: [],
      knowledge: [],
      resolvedForActorId: actorId,
    },
    tenantContext: {
      organizationId,
      workspaceId,
      actorId,
      policySnapshotId: randomUUID(),
    },
    userProfile: { schemaVersion: 1, displayName: 'Tester', preferences: {} },
    createdAt: now,
  });
  const request: RouteRequest = {
    schemaVersion: 1,
    runId: randomUUID(),
    organizationId,
    workspaceId,
    actorId,
    employeeId,
    generation: 0,
    attempt: 1,
    prompt: '你好',
  };
  return { snapshot, executionSnapshot: snapshot, request };
}

function withCapabilities(
  snapshot: EmployeeExecutionSnapshot,
): EmployeeExecutionSnapshot {
  if (snapshot.schemaVersion !== 2) throw new Error('v2 required');
  const now = '2026-08-25T00:00:00.000Z';
  const skillVersionId = randomUUID();
  const workflowRevisionId = randomUUID();
  const knowledgeRevisionId = randomUUID();
  return EmployeeExecutionSnapshotSchema.parse({
    ...snapshot,
    capabilitySnapshot: {
      ...snapshot.capabilitySnapshot,
      agentSkills: [
        {
          bindingId: randomUUID(),
          installationId: randomUUID(),
          revision: {
            kind: 'agent_skill',
            id: skillVersionId,
            agentSkillId: randomUUID(),
            slug: 'market-research',
            name: '市场研究',
            description: '研究市场和竞品',
            publisher: 'AllRice',
            revision: '1.0.0',
            status: 'published',
            checksum: `sha256:${'b'.repeat(64)}`,
            source: {
              repository: 'https://github.com/example/skills',
              commit: 'c'.repeat(40),
              path: 'market-research',
              license: 'MIT',
            },
            metadata: {
              applicableScenarios: ['竞品研究'],
              inputSchema: {},
              outputSchema: {},
              requiredToolRefs: [],
              riskLevel: 'low',
            },
            declaredCapabilities: ['storage:read'],
            publishedAt: now,
          },
          grantedCapabilities: ['storage:read'],
          effective: true,
          disabledReason: null,
          boundBy: snapshot.tenantContext.actorId,
          boundAt: now,
        },
      ],
      workflows: [
        {
          bindingId: randomUUID(),
          revision: {
            kind: 'workflow',
            id: workflowRevisionId,
            workflowId: randomUUID(),
            slug: 'weekly-report',
            name: '周报流程',
            description: '生成每周工作报告',
            revision: 1,
            status: 'published',
            checksum: `sha256:${'d'.repeat(64)}`,
            definition: {
              schemaVersion: 1,
              inputSchema: {},
              steps: [
                {
                  key: 'draft',
                  name: '起草',
                  kind: 'model',
                  dependsOn: [],
                  input: {},
                  timeoutMs: 300_000,
                  maxAttempts: 1,
                  approval: 'none',
                },
              ],
              outputSchema: {},
              failurePolicy: 'fail_fast',
              recoveryPolicy: 'checkpoint',
            },
            publishedAt: now,
          },
          effective: true,
          disabledReason: null,
          boundBy: snapshot.tenantContext.actorId,
          boundAt: now,
        },
      ],
      knowledge: [
        {
          bindingId: randomUUID(),
          revision: {
            kind: 'knowledge',
            id: knowledgeRevisionId,
            knowledgeSourceId: randomUUID(),
            slug: 'product-docs',
            name: '产品资料库',
            description: '产品说明与定价资料',
            revision: 1,
            status: 'published',
            checksum: `sha256:${'e'.repeat(64)}`,
            definition: {
              schemaVersion: 1,
              sourceKind: 'workspace_files',
              connectorBindingId: null,
              resourceRef: 'workspace',
              indexing: 'hybrid',
              updatePolicy: 'manual',
              citationRequired: true,
              allowedScopes: ['workspace'],
            },
            acl: [
              {
                principalType: 'workspace',
                principalId: snapshot.tenantContext.workspaceId,
                permission: 'read',
              },
            ],
            publishedAt: now,
          },
          effectiveAcl: [
            {
              principalType: 'workspace',
              principalId: snapshot.tenantContext.workspaceId,
              permission: 'read',
            },
          ],
          effective: true,
          disabledReason: null,
          boundBy: snapshot.tenantContext.actorId,
          boundAt: now,
        },
      ],
    },
  });
}

const tools = [
  {
    name: 'workspace.file.read',
    description: '读取工作区文件',
    requiredCapability: 'storage:read' as const,
  },
  {
    name: 'web.search',
    description: '联网搜索公开资料',
    requiredCapability: 'network:outbound' as const,
  },
  {
    name: 'web.fetch',
    description: '读取指定公开网页',
    requiredCapability: 'network:outbound' as const,
  },
  {
    name: 'automation.create',
    description: '创建提醒',
    requiredCapability: 'automation:write' as const,
  },
];

describe('capability route decision', () => {
  it('uses direct for ordinary conversation', () => {
    const input = base();
    const plan = decideCapabilityRoute({ ...input, tools });
    expect(plan.selectedKind).toBe('direct');
    expect(plan.reasonCodes).toContain('direct_no_capability_match');
  });

  it.each([
    ['请根据知识库查产品定价', 'knowledge'],
    ['用市场研究技能分析竞品', 'agent_skill'],
    ['运行周报工作流', 'workflow'],
  ] as const)('routes %s to %s', (prompt, expected) => {
    const input = base();
    const snapshot = withCapabilities(input.snapshot);
    const plan = decideCapabilityRoute({
      request: { ...input.request, prompt },
      executionSnapshot: snapshot,
      tools,
    });
    expect(plan.selectedKind).toBe(expected);
    expect(plan.reasonCodes).toContain('minimum_necessary_capability');
  });

  it('filters side-effect tools before ranking when approval is required', () => {
    const input = base({ approvalPolicy: 'confirm_side_effects' });
    const plan = decideCapabilityRoute({
      request: { ...input.request, prompt: '十分钟后提醒我开会' },
      executionSnapshot: input.snapshot,
      tools,
    });
    expect(plan.selectedKind).toBe('direct');
    expect(
      plan.candidates.find(
        (candidate) => candidate.id === 'tool:automation.create',
      ),
    ).toMatchObject({
      authorized: false,
      exclusionReason: 'excluded_approval_required',
    });
  });

  it('keeps approval-bearing workflows routable for the durable engine', () => {
    const input = base({ approvalPolicy: 'confirm_side_effects' });
    const snapshot = withCapabilities(input.snapshot);
    if (snapshot.schemaVersion !== 2) throw new Error('v2 required');
    snapshot.capabilitySnapshot.workflows[0]!.revision.definition.steps[0]!.approval =
      'required';
    const plan = decideCapabilityRoute({
      request: { ...input.request, prompt: '运行周报工作流' },
      executionSnapshot: snapshot,
      tools,
    });
    expect(
      plan.candidates.find((candidate) => candidate.id.startsWith('workflow:')),
    ).toMatchObject({
      authorized: true,
      requiresApproval: true,
      exclusionReason: null,
    });
    expect(plan.selectedKind).toBe('workflow');
  });

  it('allows the same tool only under an explicit autonomous policy', () => {
    const input = base({ approvalPolicy: 'autonomous' });
    const plan = decideCapabilityRoute({
      request: { ...input.request, prompt: '十分钟后提醒我开会' },
      executionSnapshot: input.snapshot,
      tools,
    });
    expect(plan.selectedToolNames).toEqual(['automation.create']);
  });

  it('does not pre-route tenant-authorized read-only search tools', () => {
    const input = base();
    const snapshot = withCapabilities(input.snapshot);
    const plan = decideCapabilityRoute({
      request: {
        ...input.request,
        prompt: '联网查询 SpaceX 是否上市，并给出来源链接',
      },
      executionSnapshot: snapshot,
      tools: tools.filter((tool) => tool.name !== 'web.search'),
    });
    expect(plan.selectedKind).toBe('direct');
    expect(plan.selectedToolNames).toEqual([]);
    expect(plan.reasonCodes).toContain('direct_no_capability_match');
  });

  it('leaves even an explicitly named read-only tool to the DSH Agent Loop', () => {
    const input = base();
    const snapshot = withCapabilities(input.snapshot);
    const plan = decideCapabilityRoute({
      request: { ...input.request, prompt: '必须使用 web.search 查询' },
      executionSnapshot: snapshot,
      tools: tools.filter((tool) => tool.name !== 'web.search'),
    });
    expect(plan.selectedKind).toBe('direct');
    expect(plan.selectedToolNames).toEqual([]);
  });

  it('fails closed when tenant or actor differs from the frozen snapshot', () => {
    const input = base();
    expect(() =>
      decideCapabilityRoute({
        request: { ...input.request, workspaceId: randomUUID() },
        executionSnapshot: input.snapshot,
        tools,
      }),
    ).toThrow('frozen tenant snapshot');
  });

  it('uses a stable minimum-capability tie break', () => {
    const input = base();
    const snapshot = withCapabilities(input.snapshot);
    const request = {
      ...input.request,
      prompt: '请用技能和工作流处理这件事',
    };
    const first = decideCapabilityRoute({
      request,
      executionSnapshot: snapshot,
      tools,
    });
    const second = decideCapabilityRoute({
      request,
      executionSnapshot: snapshot,
      tools,
    });
    expect(first.selectedCandidateId).toBe(second.selectedCandidateId);
    expect(first.reasonCodes).toContain('ambiguous_deterministic_tiebreak');
  });

  it('combines authorized Knowledge with an Agent Skill without widening tools', () => {
    const input = base();
    const snapshot = withCapabilities(input.snapshot);
    const plan = decideCapabilityRoute({
      request: {
        ...input.request,
        prompt: '请用市场研究技能，根据产品知识库分析竞品',
      },
      executionSnapshot: snapshot,
      tools,
    });
    expect(plan.selectedKind).toBe('agent_skill');
    expect(plan.selectedSkillVersionIds).toHaveLength(1);
    expect(plan.selectedKnowledgeRevisionIds).toHaveLength(1);
    expect(plan.selectedToolNames).toEqual([]);
  });
});
