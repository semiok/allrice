/** Pinned DSH and actual AllRice adapter, loopback model only. */
import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';
import {
  InternalKernelRequestSchema,
  evaluateExperienceRoster,
  type HarnessEvent,
} from '@allrice/contracts';
import { attendanceAnswer } from '../../../../packages/database/src/experience-validation.fixture.ts';
import { p24Fixture } from '../p24/fixture.js';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.js';
it('carries a fixed experience draft and case through native DSH without chat identity, tools or source history', async () => {
  const model = await p24Fixture(async () => ({
    text: JSON.stringify(attendanceAnswer),
  }));
  const events: HarnessEvent[] = [],
    occurrenceId = randomUUID();
  const adapter = new DshHarnessAdapter({
    runtimeRoot: model.root,
    credentialResolver: { resolve: async () => ({ apiKey: 'synthetic-only' }) },
    requestTimeoutMs: 15000,
  });
  try {
    const result = await adapter.execute({
      kernel: InternalKernelRequestSchema.parse({
        schemaVersion: 1,
        harness: 'dsh',
        employeeAssignmentId: randomUUID(),
        employeeVersionId: randomUUID(),
        sessionId: null,
        userMessageId: null,
        assistantMessageId: null,
        internalTask: { kind: 'experience_validation', occurrenceId },
        systemInstructions:
          '固定草稿：依据原始名单分别核对到场和未到人数，并分项列出。缺少名单不得推算。',
        userRequest: 'Synthetic attendance case',
        bootstrapConversation: '',
        authorizedMemoryContext: '',
        grantedCapabilities: ['model:invoke'],
        skillVersionIds: [],
      }),
      nativeSkills: [],
      tools: [],
      authorizedToolNames: [],
      storageObjects: [],
      workDirectory: model.root,
      providerSnapshot: {
        provider: 'dsh',
        authMode: 'allrice_credential',
        route: 'openai-compatible',
        model: 'p24-synthetic',
        reasoningEffort: 'high',
        credentialReference: 'test:synthetic',
        baseUrl: model.baseUrl,
      },
      executionEnvironment: {
        ALLRICE_ORGANIZATION_ID: randomUUID(),
        ALLRICE_WORKSPACE_ID: randomUUID(),
        ALLRICE_OWNER_ID: randomUUID(),
        ALLRICE_RUN_ID: randomUUID(),
        ALLRICE_JOB_ID: randomUUID(),
        ALLRICE_ATTEMPT: '1',
      },
      signal: AbortSignal.timeout(20000),
      attempt: 1,
      generation: 0,
      onEvent: async (e) => {
        events.push(e);
      },
    });
    expect(evaluateExperienceRoster(result.answer).passed).toBe(true);
    expect(model.requests).toHaveLength(1);
    expect(JSON.stringify(model.requests[0]!.messages)).toContain('固定草稿');
    // DSH retains its own planning/skill discovery tools even with an empty skill catalog.
    expect(
      (model.requests[0]!.tools ?? []).map((t) => t.function.name).sort(),
    ).toEqual(['ask_user_question', 'skill', 'todo_write']);
    expect(events.length).toBeGreaterThan(0);
    expect(
      events.every(
        (e) =>
          e.sessionId === null &&
          e.messageId === null &&
          e.internalTask?.occurrenceId === occurrenceId,
      ),
    ).toBe(true);
    expect(adapter.runtimeInventory()[0]).toMatchObject({
      sessionId: null,
      internalTask: { kind: 'experience_validation', occurrenceId },
    });
  } finally {
    await adapter.close();
    await model.close();
  }
}, 30000);
