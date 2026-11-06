import { riceToolDefinitions } from './tool-broker/definitions.js';
import {
  executeRiceTool,
  riceReadOnlyToolDefinitionsForPreview,
} from './tool-broker.js';
import { executeEmployeeMethodFileStep } from './employee-method-file-tests.js';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  SessionModelSnapshotSchema,
  ExperienceModelSnapshotSchema,
  RouteDecisionSchema,
  PlatformEmployeeDefinitionSchema,
  PlatformEmployeeRuntimeProfileSchema,
  DshNativeSkillSnapshotSchema,
  type PlatformEmployeeDefinition,
} from '@allrice/contracts';
import type * as DatabaseModule from '@allrice/database';
import {
  buildEmployeeRuntimePackage,
  claimNextPlatformEmployeeTestRun,
  completePlatformEmployeeTestRun,
  employeeMethodTestStillCurrent,
  experienceValidationStillCurrent,
  methodFileExecutionUnverified,
  freezeRouteSubscriptionSnapshot,
  employeePersonaPlatformSystemPrompt,
  runtimePackageSystemPrompt,
} from '@allrice/database';
import { DshHarnessAdapter } from './harness/dsh-adapter.js';
import { executeNextPlatformEmployeeTest } from './platform-employee-tests.js';
import { attachExecutionFailureUsage } from './harness/dsh/execution-failure-usage.js';

vi.mock('@allrice/database', async (importOriginal) => {
  const policy = await importOriginal<typeof DatabaseModule>();
  return {
    buildEmployeeRuntimePackage: policy.buildEmployeeRuntimePackage,
    claimNextPlatformEmployeeTestRun: vi.fn(),
    completePlatformEmployeeTestRun: vi.fn(),
    employeeMethodTestStillCurrent: vi.fn(),
    experienceValidationStillCurrent: vi.fn(),
    methodFileExecutionUnverified: vi.fn(),
    freezeRouteSubscriptionSnapshot: vi.fn(),
    employeePersonaPlatformSystemPrompt:
      policy.employeePersonaPlatformSystemPrompt,
    runtimePackageChecksum: policy.runtimePackageChecksum,
    runtimePackageSystemPrompt: policy.runtimePackageSystemPrompt,
  };
});
vi.mock('./employee-method-file-tests.js', () => ({
  employeeMethodFileTools: [
    {
      name: 'platform.employee.method.step',
      description: 'fixed files',
      inputSchema: { type: 'object' },
    },
  ],
  executeEmployeeMethodFileStep: vi.fn(),
}));
vi.mock('./tool-broker.js', () => ({
  executeRiceTool: vi.fn(),
  riceReadOnlyToolDefinitionsForPreview: vi.fn(() => []),
  riceToolCapability: vi.fn(() => 'storage:read'),
}));

// This unit fixture represents an already-claimed platform test. The real public
// builder derives its package from this case's definition; queue/source guards
// stay covered by the DB integration tests, not by this claim stub.
function platformTestSource(
  expressionStyle: PlatformEmployeeDefinition['identity']['expressionStyle'],
  oversized = false,
) {
  const skillId = randomUUID();
  const skillContent = '# Synthetic platform Skill\nNot method authorization.';
  const definition = PlatformEmployeeDefinitionSchema.parse({
    schemaVersion: 1,
    key: 'platform-binding-fixture',
    name: 'Binding fixture',
    description: oversized
      ? '\u0001'.repeat(1000)
      : 'Offline source identity fixture',
    appearance: {
      avatarType: 'initials',
      avatarValue: oversized ? '\u0001'.repeat(500) : 'B',
    },
    identity: {
      role: 'Fixture',
      mission: oversized
        ? '\u0001'.repeat(500)
        : 'Check original sources {{missing}}',
      workStyle: oversized ? '\u0001'.repeat(1000) : 'Return exact evidence',
      behaviorRules: ['Use authorized data only'],
      safetyBoundaries: ['No additional grants'],
      expressionStyle,
      outputLanguage: 'zh-CN',
    },
    systemPrompt: 'Preserve source identity and authorization.',
    modelPolicy: {
      provider: 'openai-codex',
      model: 'synthetic-original',
      reasoningEffort: 'high',
      timeoutMs: 300000,
      fallbackModels: [],
      credentialReference: 'deployment:synthetic',
      baseUrl: null,
    },
    capabilities: {
      nativeSkillIds: [skillId],
      workflowRevisionIds: [],
      knowledgeRevisionIds: [],
      toolNames: ['workspace.skill.read'],
      connectorRefs: [],
    },
    securityPolicy: {
      dataScopes: ['workspace'],
      approvalPolicy: 'confirm_side_effects',
      bridgeAccess: 'none',
      connectorIdentityModes: [],
      deniedCapabilities: ['secret:use'],
    },
  });
  const runtimePackage = buildEmployeeRuntimePackage({
    revision: 7,
    definition,
    skills: [
      {
        id: skillId,
        name: 'synthetic-platform-skill',
        description: 'Frozen platform Skill excluded from method tasks',
        content: skillContent,
        checksum: `sha256:${createHash('sha256').update(skillContent).digest('hex')}`,
        model_invocable: true,
        user_invocable: true,
        required_tool_refs: ['workspace.skill.read'],
        source: 'allrice',
        source_ref: 'https://example.test/synthetic-method-skill',
        version: '1.0.0',
        license: 'MIT',
        review_status: 'reviewed',
        reviewed_by_label: 'synthetic-reviewer',
        reviewed_at: new Date('2026-11-06T00:00:00.000Z'),
      },
    ],
  });
  const runtimeProfile = PlatformEmployeeRuntimeProfileSchema.parse({
    schemaVersion: 1,
    harness: 'dsh',
    distributionGeneration:
      runtimePackage.runtimeManifest.distributionGeneration,
    employeeKey: definition.key,
    provider: definition.modelPolicy.provider,
    model: definition.modelPolicy.model,
    reasoningEffort: definition.modelPolicy.reasoningEffort,
    timeoutMs: definition.modelPolicy.timeoutMs,
    credentialReference: definition.modelPolicy.credentialReference,
    baseUrl: definition.modelPolicy.baseUrl,
    systemPrompt: runtimePackageSystemPrompt({
      platformPolicy: definition.systemPrompt,
      runtimePackage,
    }),
    nativeSkillIds: runtimePackage.skills.map((skill) => skill.id),
    nativeSkillChecksums: runtimePackage.skills.map((skill) => skill.checksum),
    toolNames: definition.capabilities.toolNames,
    connectorRefs: definition.capabilities.connectorRefs,
    securityPolicy: definition.securityPolicy,
    runtimePackage,
  });
  return {
    platformEmployeeId: randomUUID(),
    platformRevisionId: randomUUID(),
    definition,
    runtimeProfile,
    nativeSkills: runtimePackage.skills,
    packageChecksum: runtimePackage.checksum,
  };
}

function claimed(
  original = platformTestSource('structured'),
): NonNullable<Awaited<ReturnType<typeof claimNextPlatformEmployeeTestRun>>> {
  const organizationId = randomUUID(),
    workspaceId = randomUUID(),
    ownerId = randomUUID(),
    runId = randomUUID();
  const modelSnapshot = SessionModelSnapshotSchema.parse({
    schemaVersion: 1,
    sessionId: randomUUID(),
    employeeId: randomUUID(),
    policyRevision: 1,
    connectionId: randomUUID(),
    modelCatalogEntryId: randomUUID(),
    harness: 'dsh',
    provider: 'openai-codex',
    authMode: 'chatgpt_subscription',
    model: 'synthetic-frozen-model',
    reasoningEffort: 'high',
    credentialReference: 'deployment:synthetic-only',
    baseUrl: null,
    fallbackPolicy: 'disabled',
    fallbackTargets: [],
    resolvedFallbacks: [],
    frozenAt: new Date().toISOString(),
  });
  const decision = RouteDecisionSchema.parse({
    schemaVersion: 1,
    id: randomUUID(),
    runId,
    organizationId,
    workspaceId,
    actorId: ownerId,
    inputChecksum: `sha256:${'1'.repeat(64)}`,
    candidates: [
      {
        id: 'cny-total-v1',
        kind: 'direct',
        name: 'Synthetic amount case',
        bindingId: null,
        requiredCapabilities: ['model:invoke'],
        risk: 'low',
        requiresApproval: false,
        authorized: true,
        exclusionReason: null,
        score: 100,
      },
    ],
    selectedKind: 'direct',
    selectedCandidateId: 'cny-total-v1',
    harness: 'dsh',
    provider: 'openai-codex',
    model: modelSnapshot.model,
    employeeId: modelSnapshot.employeeId,
    modelConnectionId: modelSnapshot.connectionId,
    modelCatalogEntryId: modelSnapshot.modelCatalogEntryId,
    modelPolicyRevision: 1,
    generation: 0,
    attempt: 1,
    reasonCodes: ['matched_explicit_intent', 'minimum_necessary_capability'],
    createdAt: new Date().toISOString(),
  });
  return {
    id: randomUUID(),
    employeeId: original.platformEmployeeId,
    revisionId: original.platformRevisionId,
    definition: original.definition,
    requestedByLabel: ownerId,
    input: {
      prompt: 'Synthetic fixed case',
      environment: 'platform',
      workspaceId,
      ownerId,
    },
    runtimeProfile: original.runtimeProfile,
    nativeSkills: original.nativeSkills,
    experienceCandidate: null,
    methodCandidate: {
      caseId: 'cny-total-v1',
      modelSnapshot,
      sourceSessionId: modelSnapshot.sessionId,
      instructions: 'Private candidate rule',
      timeoutMs: 300000,
      decision,
    },
    previewContext: {
      organizationId,
      workspaceId,
      ownerId,
      workspaceName: 'Synthetic method workspace',
      membershipId: randomUUID(),
      role: 'member',
    },
    previewExecution: {
      runId,
      jobId: randomUUID(),
      jobAttempt: 1,
      leaseToken: randomUUID(),
      startedAt: new Date().toISOString(),
      policySnapshot: {
        id: randomUUID(),
        organizationId,
        subjectId: ownerId,
        version: 1,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        memberships: [],
        grants: [],
      },
    },
  };
}
const run = () =>
  executeNextPlatformEmployeeTest({
    workerId: randomUUID(),
    executionRoot: '/tmp/allrice-method-unit',
    signal: new AbortController().signal,
  });
const receipt = {
  answer: '{"totalCents":30000}',
  provider: 'openai-codex',
  model: 'synthetic-frozen-model',
  usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
  usageComplete: true,
  cacheUsageKnown: false,
};
beforeEach(() => {
  vi.mocked(claimNextPlatformEmployeeTestRun).mockResolvedValue(claimed());
  vi.mocked(employeeMethodTestStillCurrent).mockResolvedValue(true);
  vi.mocked(methodFileExecutionUnverified).mockResolvedValue(false);
  vi.mocked(freezeRouteSubscriptionSnapshot).mockResolvedValue({
    frozen: true,
    snapshotDigest: 'synthetic',
  });
  vi.spyOn(DshHarnessAdapter.prototype, 'close').mockResolvedValue();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});
it.each([
  [
    'concise',
    '简洁，结论优先',
    '先给结论，保持表达简洁，同时保留必要证据和限制。',
  ],
  [
    'structured',
    '结构清晰，分步说明',
    '按任务需要采用清晰结构和具体步骤说明。',
  ],
  ['exploratory', '比较方案与取舍', '探索相关备选方案并说明取舍，不编造事实。'],
] as const)(
  'ordinary platform preview consumes its frozen %s PERSONA through the real kernel carrier',
  async (expressionStyle, label, meaning) => {
    const original = platformTestSource(expressionStyle);
    const { definition } = original;
    const value = {
      ...claimed(),
      employeeId: original.platformEmployeeId,
      revisionId: original.platformRevisionId,
      definition,
      runtimeProfile: PlatformEmployeeRuntimeProfileSchema.parse(
        original.runtimeProfile,
      ),
      nativeSkills: DshNativeSkillSnapshotSchema.array().parse(
        original.nativeSkills,
      ),
      methodCandidate: null,
      experienceCandidate: null,
    };
    vi.mocked(claimNextPlatformEmployeeTestRun).mockResolvedValue(value);
    const execute = vi
      .spyOn(DshHarnessAdapter.prototype, 'execute')
      .mockResolvedValue({ ...receipt, model: value.runtimeProfile.model });
    await run();
    expect(execute).toHaveBeenCalledOnce();
    const input = execute.mock.calls[0]![0];
    const documents = input.kernel.employeeDocuments;
    expect(documents).toMatchObject({ user: '', memory: '' });
    expect(documents?.persona).toBeDefined();
    const persona = JSON.parse(documents!.persona!.slice('# 人设\n'.length));
    expect(persona.name.value).toBe(definition.name);
    expect(persona.mission.value).toBe(definition.identity.mission);
    expect(persona.workStyle.value).toBe(definition.identity.workStyle);
    expect(persona.expressionStyle).toMatchObject({
      value: expressionStyle,
      label,
      meaning,
      source: 'frozen_platform_definition',
    });
    expect(persona.source).toMatchObject({
      kind: 'platform_preview',
      testId: value.id,
      platformEmployeeId: original.platformEmployeeId,
      platformRevisionId: original.platformRevisionId,
      packageChecksum: original.packageChecksum,
      definitionChecksum: `sha256:${createHash('sha256').update(JSON.stringify(definition)).digest('hex')}`,
    });
    expect(persona).not.toHaveProperty('personalRevision');
    expect(input.kernel.rootSystemInstructions).toBe(
      input.kernel.systemInstructions,
    );
    expect(input.kernel.systemInstructions).toContain(definition.systemPrompt);
    expect(input.kernel.systemInstructions).toContain(
      definition.identity.safetyBoundaries[0],
    );
    expect(input.kernel.systemInstructions).not.toContain(definition.name);
    expect(input.kernel.systemInstructions).not.toContain('# IDENTITY.md');
    expect(input.kernel.systemInstructions).not.toContain(
      '## 已发布 Skill 目录',
    );
    expect(input.kernel.runtimePackageChecksum).toBe(original.packageChecksum);
    expect(input.nativeSkills).toEqual(value.nativeSkills);
    expect(input.authorizedToolNames).toEqual(value.runtimeProfile.toolNames);
    expect(input.kernel.bootstrapConversation).toBe('');
    expect(input.kernel.authorizedMemoryContext).toBe('');
    expect(employeeMethodTestStillCurrent).not.toHaveBeenCalled();
    expect(freezeRouteSubscriptionSnapshot).not.toHaveBeenCalled();
    expect(completePlatformEmployeeTestRun).toHaveBeenCalledWith(
      value.id,
      expect.objectContaining({ error: null }),
    );
  },
);
it('does not dispatch or synthesize PERSONA after the existing claim rejects an immutable source', async () => {
  vi.mocked(claimNextPlatformEmployeeTestRun).mockResolvedValue(null);
  const execute = vi.spyOn(DshHarnessAdapter.prototype, 'execute');
  expect(await run()).toBe(false);
  expect(execute).not.toHaveBeenCalled();
  expect(completePlatformEmployeeTestRun).not.toHaveBeenCalled();
});
it('runs the frozen caller model in a fresh context without tools, files, skills or recalled history', async () => {
  const value = claimed();
  vi.mocked(claimNextPlatformEmployeeTestRun).mockResolvedValue(value);
  const execute = vi
    .spyOn(DshHarnessAdapter.prototype, 'execute')
    .mockResolvedValue(receipt);
  await run();
  const input = execute.mock.calls[0]![0];
  expect(input.providerSnapshot.model).toBe('synthetic-frozen-model');
  expect(input.nativeSubagents).toBeUndefined();
  expect(input.kernel).toMatchObject({
    bootstrapConversation: '',
    authorizedMemoryContext: '',
    grantedCapabilities: ['model:invoke'],
    skillVersionIds: [],
  });
  expect(input.kernel.systemInstructions).toContain('Private candidate rule');
  expect(input.kernel.systemInstructions).toBe(
    [
      employeePersonaPlatformSystemPrompt(value.definition),
      value.methodCandidate!.instructions,
    ].join('\n\n'),
  );
  expect(input.kernel.rootSystemInstructions).toBe(
    input.kernel.systemInstructions,
  );
  expect(input.kernel.systemInstructions).not.toContain(value.definition.name);
  expect(input.kernel.systemInstructions).not.toContain('# IDENTITY.md');
  expect(input.kernel.systemInstructions).not.toContain('## 已发布 Skill 目录');
  expect(input.kernel.employeeDocuments).toMatchObject({
    user: '',
    memory: '',
  });
  const persona = JSON.parse(
    input.kernel.employeeDocuments!.persona!.slice('# 人设\n'.length),
  );
  expect(persona.source).toEqual({
    kind: 'method_candidate',
    testId: value.id,
    platformEmployeeId: value.employeeId,
    platformRevisionId: value.revisionId,
    definitionChecksum: `sha256:${createHash('sha256').update(JSON.stringify(value.definition)).digest('hex')}`,
    packageChecksum: value.runtimeProfile.runtimePackage!.checksum,
  });
  expect(persona.name.value).toBe(value.definition.name);
  expect(persona.mission.value).toBe(value.definition.identity.mission);
  expect(persona.workStyle.value).toBe(value.definition.identity.workStyle);
  expect(persona.expressionStyle).toEqual({
    value: 'structured',
    label: '结构清晰，分步说明',
    meaning: '按任务需要采用清晰结构和具体步骤说明。',
    source: 'frozen_platform_definition',
  });
  expect(persona.boundary).toContain('工作方法候选试用');
  expect(input.kernel.runtimePackageChecksum).toBe(
    value.runtimeProfile.runtimePackage!.checksum,
  );
  expect(input.providerSnapshot.model).not.toBe(value.runtimeProfile.model);
  expect(input.tools).toEqual([]);
  expect(input.authorizedToolNames).toEqual([]);
  expect(input.storageObjects).toEqual([]);
  expect(value.nativeSkills).toHaveLength(1);
  expect(input.nativeSkills).toEqual([]);
  expect(input.onToolCall).toBeUndefined();
  expect(input.threadId).toBeUndefined();
  expect(freezeRouteSubscriptionSnapshot).toHaveBeenCalledOnce();
  expect(completePlatformEmployeeTestRun).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      error: null,
      modelExecution: expect.objectContaining({
        dispatched: true,
        usageComplete: true,
        cacheUsageKnown: false,
        costCents: null,
      }),
    }),
  );
});
it('settles an oversized complete method PERSONA without dispatching or falling back to the old prompt', async () => {
  const value = claimed(platformTestSource('structured', true));
  vi.mocked(claimNextPlatformEmployeeTestRun).mockResolvedValue(value);
  const execute = vi.spyOn(DshHarnessAdapter.prototype, 'execute');
  await run();
  expect(execute).not.toHaveBeenCalled();
  expect(completePlatformEmployeeTestRun).toHaveBeenCalledWith(
    value.id,
    expect.objectContaining({
      error: expect.objectContaining({ code: 'ZodError' }),
      modelExecution: expect.objectContaining({
        dispatched: false,
        subscriptionSnapshotCreated: true,
      }),
    }),
  );
});
it('does not dispatch a stale or revoked candidate and records a trusted undispatched result', async () => {
  vi.mocked(employeeMethodTestStillCurrent).mockResolvedValue(false);
  const execute = vi.spyOn(DshHarnessAdapter.prototype, 'execute');
  await run();
  expect(execute).not.toHaveBeenCalled();
  expect(freezeRouteSubscriptionSnapshot).not.toHaveBeenCalled();
  expect(completePlatformEmployeeTestRun).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      error: expect.objectContaining({ code: 'EMPLOYEE_METHOD_TEST_STALE' }),
      modelExecution: expect.objectContaining({
        dispatched: false,
        subscriptionSnapshotCreated: false,
      }),
    }),
  );
});
it('physically signals a running test to stop on revocation and keeps missing usage unknown', async () => {
  vi.useFakeTimers();
  vi.mocked(employeeMethodTestStillCurrent)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true)
    .mockResolvedValue(false);
  let aborted = false;
  vi.spyOn(DshHarnessAdapter.prototype, 'execute').mockImplementation(
    (input) =>
      new Promise((_, reject) => {
        input.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(input.signal.reason);
          },
          { once: true },
        );
      }),
  );
  const pending = run();
  await vi.advanceTimersByTimeAsync(2001);
  await pending;
  expect(aborted).toBe(true);
  expect(completePlatformEmployeeTestRun).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      usage: null,
      modelExecution: expect.objectContaining({
        dispatched: true,
        usageComplete: false,
        costCents: null,
      }),
    }),
  );
});
it('retains a mismatched model receipt as unverified rather than granting a subscription exemption', async () => {
  vi.spyOn(DshHarnessAdapter.prototype, 'execute').mockResolvedValue({
    ...receipt,
    model: 'wrong-model',
  });
  await run();
  expect(completePlatformEmployeeTestRun).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      error: expect.objectContaining({
        code: 'ASSISTANT_SUBSCRIPTION_RESULT_UNVERIFIED',
      }),
      modelExecution: expect.objectContaining({
        usageComplete: false,
        costCents: null,
      }),
    }),
  );
});
it('awaits a pending authority read before finalizing a model answer', async () => {
  vi.useFakeTimers();
  let resolveCheck!: (value: boolean) => void;
  let resolveModel!: (value: typeof receipt) => void;
  vi.mocked(employeeMethodTestStillCurrent)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true)
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
    );
  vi.spyOn(DshHarnessAdapter.prototype, 'execute').mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveModel = resolve;
      }),
  );
  const pending = run();
  await vi.advanceTimersByTimeAsync(2001);
  resolveModel(receipt);
  await vi.advanceTimersByTimeAsync(0);
  expect(completePlatformEmployeeTestRun).not.toHaveBeenCalled();
  resolveCheck(false);
  await pending;
  expect(completePlatformEmployeeTestRun).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      error: expect.objectContaining({ code: 'EMPLOYEE_METHOD_TEST_STALE' }),
    }),
  );
});
it.each([false, true])(
  'retains only Run-bound confirmed failure tokens (foreign=%s)',
  async (foreign) => {
    vi.spyOn(DshHarnessAdapter.prototype, 'execute').mockImplementation(
      async (input) => {
        const error = new Error('Synthetic interrupted stream');
        attachExecutionFailureUsage(
          error,
          foreign ? randomUUID() : input.executionEnvironment.ALLRICE_RUN_ID!,
          1,
          {
            usage: { inputTokens: 125, cachedInputTokens: 25, outputTokens: 8 },
            usageComplete: false,
            cacheUsageKnown: false,
          },
        );
        throw error;
      },
    );
    await run();
    const output = vi.mocked(completePlatformEmployeeTestRun).mock.calls[0]![1];
    expect(output.usage).toEqual(
      foreign
        ? null
        : { inputTokens: 125, cachedInputTokens: 25, outputTokens: 8 },
    );
    expect(output.modelExecution).toMatchObject({
      dispatched: true,
      usageComplete: false,
      costCents: null,
    });
  },
);

it('limits file-case tools and keeps an unknown backend result unverified even if the model claims success', async () => {
  const test = claimed();
  test.methodCandidate!.caseId = 'cny-file-flow-v1';
  vi.mocked(claimNextPlatformEmployeeTestRun).mockResolvedValue(test);
  vi.mocked(executeEmployeeMethodFileStep).mockImplementation(async (input) => {
    input.onUnverified('METHOD_FILE_UNKNOWN');
    return { modelContent: '{"status":"unknown"}', summary: 'unknown' };
  });
  vi.spyOn(DshHarnessAdapter.prototype, 'execute').mockImplementation(
    async (input) => {
      expect(input.authorizedToolNames).toEqual([
        'platform.employee.method.step',
      ]);
      expect(input.tools.map((t) => t.name)).toEqual([
        'platform.employee.method.step',
      ]);
      expect(input.nativeSkills).toEqual([]);
      expect(input.kernel.grantedCapabilities).toEqual(['model:invoke']);
      expect(input.kernel.systemInstructions).toBe(
        [
          employeePersonaPlatformSystemPrompt(test.definition),
          test.methodCandidate!.instructions,
        ].join('\n\n'),
      );
      expect(input.kernel.rootSystemInstructions).toBe(
        input.kernel.systemInstructions,
      );
      expect(input.kernel.employeeDocuments).toMatchObject({
        user: '',
        memory: '',
      });
      const persona = JSON.parse(
        input.kernel.employeeDocuments!.persona!.slice('# 人设\n'.length),
      );
      expect(persona.source).toMatchObject({
        kind: 'method_candidate',
        testId: test.id,
        platformEmployeeId: test.employeeId,
        platformRevisionId: test.revisionId,
      });
      expect(persona.expressionStyle.meaning).toBe(
        '按任务需要采用清晰结构和具体步骤说明。',
      );
      expect(input.storageObjects).toEqual([]);
      expect(input.kernel.skillVersionIds).toEqual([]);
      expect(input.kernel.bootstrapConversation).toBe('');
      expect(input.kernel.authorizedMemoryContext).toBe('');
      expect(input.providerSnapshot.model).toBe(
        test.methodCandidate!.modelSnapshot.model,
      );
      await input.onToolCall!({
        id: 'opaque-model-call',
        name: 'platform.employee.method.step',
        arguments: { stage: 'normalize', script: 'x' },
      });
      return receipt;
    },
  );
  await run();
  expect(completePlatformEmployeeTestRun).toHaveBeenCalledWith(
    test.id,
    expect.objectContaining({
      answer: null,
      error: expect.objectContaining({
        code: 'EMPLOYEE_METHOD_TEST_EXECUTION_UNVERIFIED',
      }),
      usage: receipt.usage,
      modelExecution: expect.objectContaining({ usageComplete: true }),
    }),
  );
});

it('uses the original experience draft with true non-chat identity, no unrelated policy/tools and frozen occurrence billing', async () => {
  const test = claimed(),
    original = test.methodCandidate!;
  test.methodCandidate = null;
  test.experienceCandidate = {
    caseId: 'attendance-roster-v1',
    occurrenceId: test.id,
    assignmentId: randomUUID(),
    employeeVersionId: randomUUID(),
    modelSnapshot: ExperienceModelSnapshotSchema.parse({
      ...original.modelSnapshot,
      schemaVersion: 2,
      sessionId: null,
      occurrenceId: test.id,
    }),
    timeoutMs: 300000,
    instructions: 'Original immutable attendance draft',
    decision: original.decision,
  };
  vi.mocked(claimNextPlatformEmployeeTestRun).mockResolvedValue(test);
  vi.mocked(experienceValidationStillCurrent).mockResolvedValue(true);
  const execute = vi
    .spyOn(DshHarnessAdapter.prototype, 'execute')
    .mockResolvedValue(receipt);
  await run();
  const input = execute.mock.calls[0]![0];
  expect(input.kernel).toMatchObject({
    sessionId: null,
    userMessageId: null,
    assistantMessageId: null,
    internalTask: { kind: 'experience_validation', occurrenceId: test.id },
    systemInstructions: 'Original immutable attendance draft',
    authorizedMemoryContext: '',
    bootstrapConversation: '',
  });
  expect(input.kernel.systemInstructions).not.toContain('Published base');
  expect(input.kernel.systemInstructions).not.toContain(
    test.definition.systemPrompt,
  );
  expect(input.kernel.employeeDocuments).toBeUndefined();
  expect(input.kernel.rootSystemInstructions).toBeUndefined();
  expect(input.nativeSubagents).toBeUndefined();
  expect(input.nativeSkills).toEqual([]);
  expect(input.tools).toEqual([]);
  expect(input.onToolCall).toBeUndefined();
  expect(freezeRouteSubscriptionSnapshot).toHaveBeenCalledWith(
    expect.objectContaining({
      snapshot: expect.objectContaining({
        version: 2,
        occurrenceId: test.id,
        sessionId: null,
      }),
    }),
  );
  expect(completePlatformEmployeeTestRun).toHaveBeenCalledWith(
    test.id,
    expect.objectContaining({
      error: null,
      modelExecution: expect.objectContaining({
        dispatched: true,
        usageComplete: true,
        costCents: null,
      }),
    }),
  );
});

it('rechecks cancellation after subscription freeze and never dispatches the invalidated experience', async () => {
  const test = claimed(),
    original = test.methodCandidate!;
  test.methodCandidate = null;
  test.experienceCandidate = {
    caseId: 'attendance-roster-v1',
    occurrenceId: test.id,
    assignmentId: randomUUID(),
    employeeVersionId: randomUUID(),
    modelSnapshot: ExperienceModelSnapshotSchema.parse({
      ...original.modelSnapshot,
      schemaVersion: 2,
      sessionId: null,
      occurrenceId: test.id,
    }),
    timeoutMs: 300000,
    instructions: 'Original immutable attendance draft',
    decision: original.decision,
  };
  vi.mocked(claimNextPlatformEmployeeTestRun).mockResolvedValue(test);
  vi.mocked(experienceValidationStillCurrent).mockResolvedValue(true);
  vi.mocked(freezeRouteSubscriptionSnapshot).mockImplementationOnce(
    async () => {
      vi.mocked(experienceValidationStillCurrent).mockResolvedValue(false);
      return { frozen: true, snapshotDigest: 'synthetic' };
    },
  );
  const execute = vi.spyOn(DshHarnessAdapter.prototype, 'execute');
  await run();
  expect(execute).not.toHaveBeenCalled();
  expect(completePlatformEmployeeTestRun).toHaveBeenCalledWith(
    test.id,
    expect.objectContaining({
      modelExecution: expect.objectContaining({
        dispatched: false,
        subscriptionSnapshotCreated: true,
      }),
    }),
  );
});

it('binds the personal Skill overlay to the actual test lease and fails closed without giving it chat or write tools', async () => {
  const test = claimed(),
    original = test.methodCandidate!,
    skill = (() => {
      const pin = {
        organizationId: randomUUID(),
        ownerId: randomUUID(),
        instanceId: randomUUID(),
        installationId: randomUUID(),
        versionId: randomUUID(),
        bindingId: randomUUID(),
        bindingEpoch: 1,
        definitionChecksum: `sha256:${'a'.repeat(64)}`,
      };
      return {
        pin,
        personalSkills: {
          schemaVersion: 1 as const,
          instanceId: pin.instanceId,
          skills: [pin],
          checksum: `sha256:${'b'.repeat(64)}`,
        },
        nativeSkill: {
          id: pin.versionId,
          name: 'attendance-counting',
          description: 'Synthetic',
          content: '# Synthetic',
          checksum: `sha256:${'c'.repeat(64)}`,
          invocation: { modelInvocable: true, userInvocable: true },
          personal: pin,
          requiredToolRefs: [],
        },
      };
    })();
  test.methodCandidate = null;
  test.experienceCandidate = {
    caseId: 'attendance-roster-v1',
    occurrenceId: test.id,
    assignmentId: randomUUID(),
    employeeVersionId: randomUUID(),
    modelSnapshot: ExperienceModelSnapshotSchema.parse({
      ...original.modelSnapshot,
      schemaVersion: 2,
      sessionId: null,
      occurrenceId: test.id,
    }),
    timeoutMs: 300000,
    instructions: 'Fixed draft and Skill',
    decision: original.decision,
    personalSkills: skill.personalSkills,
    nativeSkills: [skill.nativeSkill],
  };
  vi.mocked(claimNextPlatformEmployeeTestRun).mockResolvedValue(test);
  vi.mocked(experienceValidationStillCurrent).mockResolvedValue(true);
  vi.spyOn(DshHarnessAdapter.prototype, 'execute').mockImplementation(
    async (input) => {
      expect(input.kernel).toMatchObject({
        sessionId: null,
        internalTask: { kind: 'experience_validation', occurrenceId: test.id },
        skillVersionIds: [skill.pin.versionId],
      });
      expect(input.nativeSkills).toEqual([skill.nativeSkill]);
      expect(input.tools).toEqual([]);
      expect(input.onToolCall).toBeUndefined();
      expect(input.contentGuard?.generationId).toBe(test.id);
      await input.contentGuard!.check();
      expect(experienceValidationStillCurrent).toHaveBeenLastCalledWith(
        test.id,
        expect.objectContaining({
          runId: test.previewExecution.runId,
          jobId: test.previewExecution.jobId,
          leaseToken: test.previewExecution.leaseToken,
        }),
      );
      vi.mocked(experienceValidationStillCurrent).mockResolvedValue(false);
      await expect(input.contentGuard!.check()).rejects.toThrow(
        '联合验证已停止',
      );
      vi.mocked(experienceValidationStillCurrent).mockRejectedValue(
        new Error('synthetic authority read failed'),
      );
      await expect(input.contentGuard!.check()).rejects.toThrow(
        'authority read failed',
      );
      vi.mocked(experienceValidationStillCurrent).mockResolvedValue(true);
      return receipt;
    },
  );
  await run();
});

it.each(['call', 'root'] as const)(
  'preview propagates %s cancellation to the actual Broker callback',
  async (cause) => {
    const test = claimed();
    test.methodCandidate = null;
    test.runtimeProfile.toolNames = ['web.fetch'];
    test.runtimeProfile.reasoningEffort = 'high';
    test.runtimeProfile.credentialReference = 'synthetic-preview';
    test.runtimeProfile.baseUrl = 'http://127.0.0.1:1/v1';
    const root = new AbortController(),
      call = new AbortController();
    const reason = new Error('synthetic cancellation');
    vi.mocked(claimNextPlatformEmployeeTestRun).mockResolvedValue(test);
    vi.mocked(riceReadOnlyToolDefinitionsForPreview).mockReturnValue(
      riceToolDefinitions.filter((tool) => tool.name === 'web.fetch'),
    );
    let observed:
      | { runId: string; before: boolean | undefined; reason: unknown }
      | undefined;
    vi.mocked(executeRiceTool).mockImplementation(async (input) => {
      const before = input.signal?.aborted;
      (cause === 'call' ? call : root).abort(reason);
      observed = {
        runId: input.context.runId,
        before,
        reason: input.signal?.reason,
      };
      return { modelContent: '{}', summary: 'fixture' };
    });
    vi.spyOn(DshHarnessAdapter.prototype, 'execute').mockImplementation(
      async (input) => {
        await input.onToolCall!(
          {
            id: 'native-fetch',
            name: 'web.fetch',
            arguments: { url: 'https://example.com' },
          },
          { signal: call.signal },
        );
        return receipt;
      },
    );
    await executeNextPlatformEmployeeTest({
      workerId: randomUUID(),
      executionRoot: '/tmp/allrice-preview-unit',
      signal: root.signal,
    });
    expect(executeRiceTool).toHaveBeenCalledOnce();
    expect(observed).toEqual({
      runId: test.previewExecution.runId,
      before: false,
      reason,
    });
  },
);
