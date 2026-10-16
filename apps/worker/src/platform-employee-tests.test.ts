import { executeEmployeeMethodFileStep } from './employee-method-file-tests.js';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  SessionModelSnapshotSchema,
  ExperienceModelSnapshotSchema,
  type RouteDecision,
} from '@allrice/contracts';
import {
  claimNextPlatformEmployeeTestRun,
  completePlatformEmployeeTestRun,
  employeeMethodTestStillCurrent,
  experienceValidationStillCurrent,
  methodFileExecutionUnverified,
  freezeRouteSubscriptionSnapshot,
} from '@allrice/database';
import { DshHarnessAdapter } from './harness/dsh-adapter.js';
import { executeNextPlatformEmployeeTest } from './platform-employee-tests.js';
import { attachAssistantFailureUsage } from './harness/dsh/assistant-outcome.js';

vi.mock('@allrice/database', () => ({
  claimNextPlatformEmployeeTestRun: vi.fn(),
  completePlatformEmployeeTestRun: vi.fn(),
  employeeMethodTestStillCurrent: vi.fn(),
  experienceValidationStillCurrent: vi.fn(),
  methodFileExecutionUnverified: vi.fn(),
  freezeRouteSubscriptionSnapshot: vi.fn(),
}));
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

function claimed() {
  const organizationId = randomUUID(),
    workspaceId = randomUUID(),
    ownerId = randomUUID();
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
  const decision = {
    id: randomUUID(),
    harness: 'dsh',
    provider: 'openai-codex',
    model: modelSnapshot.model,
    employeeId: modelSnapshot.employeeId,
    modelConnectionId: modelSnapshot.connectionId,
    modelCatalogEntryId: modelSnapshot.modelCatalogEntryId,
    modelPolicyRevision: 1,
  } as RouteDecision;
  return {
    id: randomUUID(),
    requestedByLabel: ownerId,
    input: { prompt: 'Synthetic fixed case' },
    runtimeProfile: {
      timeoutMs: 300000,
      provider: 'gemini',
      model: 'different-platform-model',
      systemPrompt: 'Published base',
      toolNames: ['workspace.file.read'],
      nativeSkillIds: [randomUUID()],
      securityPolicy: { deniedCapabilities: [] },
    },
    nativeSkills: [{ id: randomUUID() }],
    methodCandidate: {
      modelSnapshot,
      sourceSessionId: modelSnapshot.sessionId,
      instructions: 'Private candidate rule',
      timeoutMs: 300000,
      decision,
    },
    previewContext: { organizationId, workspaceId, ownerId },
    previewExecution: {
      runId: randomUUID(),
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
  } as unknown as NonNullable<
    Awaited<ReturnType<typeof claimNextPlatformEmployeeTestRun>>
  >;
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
it('runs the frozen caller model in a fresh context without tools, files, skills or recalled history', async () => {
  const execute = vi
    .spyOn(DshHarnessAdapter.prototype, 'execute')
    .mockResolvedValue(receipt);
  await run();
  const input = execute.mock.calls[0]![0];
  expect(input.providerSnapshot.model).toBe('synthetic-frozen-model');
  expect(input.kernel).toMatchObject({
    bootstrapConversation: '',
    authorizedMemoryContext: '',
    grantedCapabilities: ['model:invoke'],
    skillVersionIds: [],
  });
  expect(input.kernel.systemInstructions).toContain('Private candidate rule');
  expect(input.tools).toEqual([]);
  expect(input.authorizedToolNames).toEqual([]);
  expect(input.storageObjects).toEqual([]);
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
        attachAssistantFailureUsage(
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
