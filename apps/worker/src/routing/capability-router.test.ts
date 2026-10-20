import { randomUUID } from 'node:crypto';

import {
  EmployeeExecutionSnapshotSchema,
  BrandContentWorkflowInvocationSchema,
  brandContentTemplateKeys,
  type EmployeeExecutionSnapshot,
  type RouteRequest,
} from '@allrice/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { riceToolDefinitionsForTurn } from '../tool-broker/definitions.js';

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
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    '请在 15 分钟后，在这个对话中只回复校验词「ONCE-TEST」。请实际创建一次性任务，不要现在执行。',
    '十分钟后提醒我开会。',
    '一分钟后在此对话回复测试标记。',
  ])(
    'admits native once independently of keywords under confirm_external: %s',
    (prompt) => {
      vi.stubEnv('ALLRICE_NATIVE_ONCE_ENABLED', '1');
      const input = base({ approvalPolicy: 'confirm_external' });
      const plan = decideCapabilityRoute({
        request: { ...input.request, prompt },
        executionSnapshot: input.snapshot,
        tools,
      });
      expect(
        plan.candidates.find((c) => c.id === 'tool:automation.create'),
      ).toMatchObject({ authorized: true, exclusionReason: null });
      expect(
        riceToolDefinitionsForTurn(
          ['automation:write'],
          ['automation.create'],
          plan.selectedToolNames,
        ).map((t) => t.name),
      ).toEqual(['automation.create']);
      // An exact backend/authority exception never grants unrelated side effects.
      const other = decideCapabilityRoute({
        request: { ...input.request, prompt },
        executionSnapshot: input.snapshot,
        tools: [
          ...tools,
          {
            name: 'automation.other',
            description: 'other',
            requiredCapability: 'automation:write',
          },
        ],
      });
      expect(
        other.candidates.find((c) => c.id === 'tool:automation.other'),
      ).toMatchObject({
        authorized: false,
        exclusionReason: 'excluded_approval_required',
      });
    },
  );

  it('requires the feature, frozen binding and capability, even when selected', () => {
    vi.stubEnv('ALLRICE_NATIVE_RECURRING_ENABLED', '0');
    vi.stubEnv('ALLRICE_NATIVE_ONCE_ENABLED', '1');
    for (const allowed of [undefined, []])
      expect(
        riceToolDefinitionsForTurn(['automation:write'], allowed, [
          'automation.create',
        ]),
      ).toEqual([]);
    expect(
      riceToolDefinitionsForTurn(
        [],
        ['automation.create'],
        ['automation.create'],
      ),
    ).toEqual([]);
    vi.stubEnv('ALLRICE_NATIVE_ONCE_ENABLED', '0');
    expect(
      riceToolDefinitionsForTurn(
        ['automation:write'],
        ['automation.create'],
        ['automation.create'],
      ),
    ).toEqual([]);
  });
  it('exposes the same human-governed tool when only recurring is enabled', () => {
    vi.stubEnv('ALLRICE_NATIVE_ONCE_ENABLED', '0');
    vi.stubEnv('ALLRICE_NATIVE_RECURRING_ENABLED', '1');
    const input = base({ approvalPolicy: 'confirm_external' });
    const plan = decideCapabilityRoute({
      request: { ...input.request, prompt: '请每隔两分钟回复校验词。' },
      executionSnapshot: input.snapshot,
      tools,
    });
    expect(
      plan.candidates.find((c) => c.id === 'tool:automation.create'),
    ).toMatchObject({ authorized: true, exclusionReason: null });
    expect(
      riceToolDefinitionsForTurn(
        ['automation:write'],
        ['automation.create'],
        [],
      ).map((t) => t.name),
    ).toEqual(['automation.create']);
    expect(
      riceToolDefinitionsForTurn(
        ['automation:write'],
        [],
        ['automation.create'],
      ),
    ).toEqual([]);
    expect(
      riceToolDefinitionsForTurn(
        [],
        ['automation.create'],
        ['automation.create'],
      ),
    ).toEqual([]);
  });
  it('uses direct for ordinary conversation', () => {
    const input = base();
    const plan = decideCapabilityRoute({ ...input, tools });
    expect(plan.selectedKind).toBe('direct');
    expect(plan.reasonCodes).toContain('direct_no_capability_match');
  });

  it.each([
    ['请根据知识库查产品定价', 'knowledge'],
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

  it('leaves DSH-native Skill selection to the DSH Agent Loop', () => {
    const input = base();
    const snapshot = withCapabilities(input.snapshot);
    const plan = decideCapabilityRoute({
      request: { ...input.request, prompt: '用市场研究技能分析竞品' },
      executionSnapshot: snapshot,
      tools,
    });
    expect(plan.selectedKind).toBe('direct');
    expect(plan.selectedSkillVersionIds).toEqual([]);
    expect(
      plan.candidates.some((candidate) => candidate.kind === 'agent_skill'),
    ).toBe(false);
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

  it('keeps workflow routing stable when a Skill is also mentioned', () => {
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
    expect(first.selectedKind).toBe('workflow');
  });

  it('routes Knowledge while leaving the accompanying Skill to DSH', () => {
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
    expect(plan.selectedKind).toBe('knowledge');
    expect(plan.selectedSkillVersionIds).toEqual([]);
    expect(plan.selectedKnowledgeRevisionIds).toHaveLength(1);
    expect(plan.selectedToolNames).toEqual([]);
  });
});

type SnapshotV2 = Extract<EmployeeExecutionSnapshot, { schemaVersion: 2 }>;
type WorkflowBinding = SnapshotV2['capabilitySnapshot']['workflows'][number];

function businessWorkflowRouteFixture() {
  const original = base();
  const directory = withCapabilities(original.snapshot);
  if (directory.schemaVersion !== 2) throw Error('v2 fixture required');
  const ordinary = directory.capabilitySnapshot.workflows[0]!;
  const workflowId = randomUUID();
  const instanceId = randomUUID();
  const business = (revision: number, name: string): WorkflowBinding => ({
    ...structuredClone(ordinary),
    bindingId: randomUUID(),
    revision: {
      ...structuredClone(ordinary.revision),
      id: randomUUID(),
      workflowId,
      revision,
      slug: `brand-content-topics-v${revision}`,
      name,
      checksum: `sha256:${String(revision).repeat(64)}`,
      definition: {
        ...structuredClone(ordinary.revision.definition),
        inputSchema: { 'x-allrice-brand-content': 'topics' },
      },
    },
  });
  const old = business(1, '旧版品牌内容流程');
  const newer = business(2, '新版品牌内容流程');
  const invocation = BrandContentWorkflowInvocationSchema.parse({
    schemaVersion: 1,
    startId: randomUUID(),
    instanceId,
    sceneId: null,
    workflowRevisionId: old.revision.id,
    packageDigest: `sha256:${'a'.repeat(64)}`,
    templateKey: brandContentTemplateKeys.topics,
    input: {
      stage: 'topics',
      brandId: randomUUID(),
      brandName: '仅用于路由fixture的品牌',
      contextRevisionId: randomUUID(),
      contextDigest: `sha256:${'b'.repeat(64)}`,
      context: {
        audience: '单测受众',
        tone: '准确',
        requirements: '仅用给定事实',
        facts: [{ id: 'one', text: '仅用于单测的事实' }],
      },
      platform: '小红书',
      count: 5,
    },
  });
  const snapshot = EmployeeExecutionSnapshotSchema.parse({
    ...directory,
    instance: {
      id: instanceId,
      assignmentId: directory.assignment.id,
      organizationId: directory.tenantContext.organizationId,
      workspaceId: directory.tenantContext.workspaceId,
      ownerId: directory.tenantContext.actorId,
      kind: 'custom',
      revision: 1,
      profile: { name: '普通名字也不提供路由授权' },
      creationSource: {
        kind: 'tenant_version',
        employeeVersionId: directory.employee.versionId,
      },
      source: {
        kind: 'tenant_version',
        employeeVersionId: directory.employee.versionId,
      },
    },
    workflowInvocation: invocation,
    capabilitySnapshot: {
      ...directory.capabilitySnapshot,
      workflows: [newer, ordinary, old],
    },
  });
  if (snapshot.schemaVersion !== 2) throw Error('v2 fixture required');
  return {
    snapshot,
    request: original.request,
    old: snapshot.capabilitySnapshot.workflows.find(
      (binding) => binding.revision.id === old.revision.id,
    )!,
    newer: snapshot.capabilitySnapshot.workflows.find(
      (binding) => binding.revision.id === newer.revision.id,
    )!,
    ordinary: snapshot.capabilitySnapshot.workflows.find(
      (binding) => binding.revision.id === ordinary.revision.id,
    )!,
  };
}

describe('MET194 explicit fixed business workflow routing', () => {
  it.each([
    '你好',
    '请生成品牌内容选题',
    '新版品牌内容流程，请采用最新发布的方法',
  ])(
    'does not infer a private business invocation from prompt %s or a matching employee name',
    (prompt) => {
      const f = businessWorkflowRouteFixture();
      delete f.snapshot.workflowInvocation;
      if (f.snapshot.instance)
        f.snapshot.instance.profile.name = '品牌内容选题专员';
      const plan = decideCapabilityRoute({
        request: { ...f.request, prompt },
        executionSnapshot: f.snapshot,
        tools,
      });
      expect(plan.selectedKind).toBe('direct');
      expect(plan.selectedWorkflowRevisionIds).toEqual([]);
      for (const binding of [f.old, f.newer])
        expect(
          plan.candidates.find(
            (candidate) => candidate.id === `workflow:${binding.revision.id}`,
          ),
        ).toMatchObject({
          authorized: false,
          exclusionReason: 'excluded_not_effective',
        });
    },
  );

  it('preserves ordinary authorized workflow routing without turning it into a private business invocation', () => {
    const f = businessWorkflowRouteFixture();
    delete f.snapshot.workflowInvocation;
    const plan = decideCapabilityRoute({
      request: { ...f.request, prompt: '运行周报工作流' },
      executionSnapshot: f.snapshot,
      tools,
    });
    expect(plan.selectedWorkflowRevisionIds).toEqual([f.ordinary.revision.id]);
  });

  it('keeps the frozen v1 selection when v2 is present, first in the directory, and explicitly named', () => {
    const f = businessWorkflowRouteFixture();
    const pinBefore = structuredClone(f.snapshot.workflowInvocation);
    const plan = decideCapabilityRoute({
      request: {
        ...f.request,
        prompt: '新版品牌内容流程 brand-content-topics-v2，请使用最新版本',
      },
      executionSnapshot: f.snapshot,
      tools,
    });
    expect(plan.selectedKind).toBe('workflow');
    expect(plan.selectedWorkflowRevisionIds).toEqual([f.old.revision.id]);
    expect(plan.selectedCandidateId).toBe(
      `workflow:${f.snapshot.workflowInvocation!.workflowRevisionId}`,
    );
    const v2 = plan.candidates.find(
      (candidate) => candidate.id === `workflow:${f.newer.revision.id}`,
    )!;
    const v1 = plan.candidates.find(
      (candidate) => candidate.id === `workflow:${f.old.revision.id}`,
    )!;
    expect(v2.score).toBeGreaterThan(v1.score);
    expect(v2.authorized).toBe(false);
    expect(f.snapshot.workflowInvocation).toEqual(pinBefore);
  });

  it.each(['missing_v1', 'disabled_v1', 'unknown_pin'] as const)(
    'fails closed for %s even when v2 and an ordinary named workflow remain available',
    (change) => {
      const f = businessWorkflowRouteFixture();
      if (change === 'missing_v1')
        f.snapshot.capabilitySnapshot.workflows =
          f.snapshot.capabilitySnapshot.workflows.filter(
            (binding) => binding.revision.id !== f.old.revision.id,
          );
      if (change === 'disabled_v1') {
        f.old.effective = false;
        f.old.disabledReason = 'binding_disabled';
      }
      if (change === 'unknown_pin')
        f.snapshot.workflowInvocation!.workflowRevisionId = randomUUID();
      expect(() =>
        decideCapabilityRoute({
          request: { ...f.request, prompt: '运行周报工作流或新版品牌内容流程' },
          executionSnapshot: f.snapshot,
          tools,
        }),
      ).toThrow('business workflow is not authorized');
    },
  );

  it.each(['workflowRevisionId', 'packageDigest', 'startId'] as const)(
    'rejects a persisted invocation missing %s instead of falling through to a named workflow',
    (field) => {
      const f = businessWorkflowRouteFixture();
      // Simulate corrupt historical JSON at the execution boundary; no schema
      // wrapper in the test may sanitize this before the router sees it.
      Reflect.deleteProperty(f.snapshot.workflowInvocation!, field);
      expect(() =>
        decideCapabilityRoute({
          request: { ...f.request, prompt: '运行周报工作流' },
          executionSnapshot: f.snapshot,
          tools,
        }),
      ).toThrow();
    },
  );

  it.each([
    'digest_format',
    'template_stage',
    'binding_stage',
    'missing_business_marker',
    'ordinary_workflow_pin',
    'other_instance',
    'general_instance',
  ] as const)(
    'rejects %s rather than borrowing another workflow or package scope',
    (mismatch) => {
      const f = businessWorkflowRouteFixture();
      if (mismatch === 'digest_format')
        f.snapshot.workflowInvocation!.packageDigest = 'not-a-package-digest';
      if (mismatch === 'template_stage')
        f.snapshot.workflowInvocation!.templateKey =
          brandContentTemplateKeys.article;
      if (mismatch === 'binding_stage')
        f.old.revision.definition.inputSchema['x-allrice-brand-content'] =
          'article';
      if (mismatch === 'missing_business_marker')
        delete f.old.revision.definition.inputSchema['x-allrice-brand-content'];
      if (mismatch === 'ordinary_workflow_pin')
        f.snapshot.workflowInvocation!.workflowRevisionId =
          f.ordinary.revision.id;
      if (mismatch === 'other_instance')
        f.snapshot.workflowInvocation!.instanceId = randomUUID();
      if (mismatch === 'general_instance')
        f.snapshot.instance!.kind = 'general';
      expect(() =>
        decideCapabilityRoute({
          request: { ...f.request, prompt: '运行周报工作流' },
          executionSnapshot: f.snapshot,
          tools,
        }),
      ).toThrow();
    },
  );
});
