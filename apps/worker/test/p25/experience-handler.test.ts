import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { ClaimedJobHandlerInput } from '../../src/job-runner.js';
import type * as Database from '@allrice/database';
import { executeExperienceConsolidation } from '../../src/jobs/experience-consolidation.js';

const ports = vi.hoisted(() => ({
  frozen: vi.fn(),
  route: vi.fn(),
  complete: vi.fn(),
  subscription: vi.fn(),
  admit: vi.fn(),
  execute: vi.fn(),
  close: vi.fn(),
}));
vi.mock('@allrice/database', async (load) => ({
  ...(await load<typeof Database>()),
  getExperienceExecution: ports.frozen,
  recordRouteDecision: ports.route,
  completeRouteDecision: ports.complete,
  freezeRouteSubscriptionSnapshot: ports.subscription,
  admitModelExecution: ports.admit,
}));
vi.mock('../../src/harness/dsh-adapter.js', () => ({
  DshHarnessAdapter: class {
    execute = ports.execute;
    close = ports.close;
  },
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

it.each([false, true])(
  'uses the existing API model route and retains accounting on identity failure=%s',
  async (wrongModel) => {
    const ownerId = randomUUID(),
      runId = randomUUID(),
      sourceId = randomUUID();
    const occurrence = {
      id: randomUUID(),
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      ownerId,
      employeeId: randomUUID(),
      employeeVersionId: randomUUID(),
      assignmentId: randomUUID(),
      currentRules: { platformRequirements: ['必须单列退款'], sources: [] },
      sources: [
        {
          id: sourceId,
          excerpt: '之前漏算退款。',
          evidence: { kind: 'correction' },
        },
      ],
    };
    const model = {
      provider: 'openai-compatible',
      harness: 'dsh',
      authMode: 'api_key',
      model: 'fixture-api',
      credentialReference: 'test:api',
      baseUrl: 'http://127.0.0.1:1',
      reasoningEffort: 'high',
      connectionId: randomUUID(),
      modelCatalogEntryId: randomUUID(),
      policyRevision: 1,
      runLimits: {
        maxInputTokens: 24000,
        maxOutputTokens: 4000,
        maxTotalTokens: 28000,
        timeoutMs: 300000,
        maxCostCents: 100,
      },
    };
    const output = {
      schemaVersion: 1,
      drafts: [],
      discarded: [{ sourceIds: [sourceId], reason: '现行规则已覆盖' }],
    };
    ports.frozen.mockResolvedValue({
      occurrence,
      execution: {
        model,
        nativeSkills: [
          {
            id: randomUUID(),
            name: 'experience-consolidation',
            content: 'Review evidence.',
          },
        ],
        catalog: {},
      },
    });
    ports.route.mockImplementation(async (route) => route);
    ports.execute.mockResolvedValue({
      answer: JSON.stringify(output),
      provider: model.provider,
      model: wrongModel ? 'foreign-model' : model.model,
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 },
      usageComplete: true,
      cacheUsageKnown: true,
    });
    // No tariff configured must remain unknown, never an invented zero fee.
    vi.stubEnv('ALLRICE_MODEL_PRICING_JSON', '');
    const input = {
      execution: {
        job: {
          id: randomUUID(),
          ownerId,
          attempt: 1,
          timeoutAt: new Date(Date.now() + 300000).toISOString(),
        },
        context: {
          runId,
          organizationId: occurrence.organizationId,
          workspaceId: occurrence.workspaceId,
        },
      },
      isolation: { workDirectory: '/unused-mocked-runtime' },
      signal: AbortSignal.timeout(5000),
      onHarnessEvent: async () => {},
    } as unknown as ClaimedJobHandlerInput;
    if (wrongModel)
      await expect(executeExperienceConsolidation(input)).rejects.toMatchObject(
        { retryable: false },
      );
    else expect(await executeExperienceConsolidation(input)).toEqual(output);
    expect(ports.subscription).not.toHaveBeenCalled();
    expect(ports.admit).toHaveBeenCalledOnce();
    const dispatched = ports.execute.mock.calls[0]![0];
    expect(JSON.parse(dispatched.kernel.userRequest)).toMatchObject({
      currentRules: occurrence.currentRules,
      budget: model.runLimits,
    });
    expect(dispatched.kernel.sessionId).toBeNull();
    expect(dispatched.authorizedToolNames).toEqual([]);
    expect(ports.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: expect.objectContaining({
          status: wrongModel ? 'failed' : 'succeeded',
          costCents: null,
          inputTokens: 100,
          outputTokens: 20,
        }),
      }),
    );
    expect(ports.close).toHaveBeenCalledOnce();
  },
);
