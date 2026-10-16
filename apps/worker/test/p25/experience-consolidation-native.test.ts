/** Actual pinned DSH + Skill + wire; synthetic loopback model, no paid request. */
import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';
import {
  InternalKernelRequestSchema,
  HarnessEventSchema,
  validateExperienceDraftOutput,
  type HarnessEvent,
} from '@allrice/contracts';
import { loadPlatformContentCatalog } from '../../../../packages/database/src/platform-content/catalog.ts';
import { runtimePolicyDigest } from '../../../../packages/database/src/runtime-policy.ts';
import { p24Fixture } from '../p24/fixture.js';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.js';
import { normalizeHarnessRunEvent } from '../../src/harness/runtime-contract.js';
it('loads the exact consolidation Skill in a private non-chat runtime and carries the receipt to durable events', async () => {
  const sourceId = randomUUID(),
    occurrenceId = randomUUID();
  const output = {
    schemaVersion: 1,
    drafts: [
      {
        sourceIds: [sourceId],
        rule: '单列退款后汇总净回款。',
        reason: '直接纠错反馈',
        applicability: '含退款的对账',
        confidence: 'tentative',
        validation: {
          kind: 'calculation',
          check: '含退款的样本独立复算净回款。',
        },
      },
    ],
    discarded: [],
  };
  const model = await p24Fixture(async (_request, index) =>
    index === 1
      ? {
          nativeTool: {
            name: 'skill',
            arguments: { name: 'experience-consolidation' },
          },
        }
      : { text: JSON.stringify(output) },
  );
  const catalog = await loadPlatformContentCatalog(),
    entry = catalog.skills.find((s) => s.name === 'experience-consolidation')!;
  const nativeSkills = [
    {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      content: entry.content,
      checksum: entry.checksum,
      invocation: {
        modelInvocable: entry.modelInvocable,
        userInvocable: entry.userInvocable,
      },
      requiredToolRefs: entry.requiredToolRefs,
    },
  ];
  const skills = [
    {
      id: entry.id,
      name: entry.name,
      version: entry.version,
      checksum: entry.checksum,
      source: entry.source,
      sourceRef: entry.sourceRef,
      license: entry.license,
      reviewedByLabel: entry.reviewedByLabel,
    },
  ];
  const events: HarnessEvent[] = [];
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
        internalTask: { kind: 'experience_consolidation', occurrenceId },
        systemInstructions:
          'Load experience-consolidation. Return only the requested JSON.',
        userRequest: JSON.stringify({
          sourceId,
          feedback: '退款漏了，应单列退款',
        }),
        bootstrapConversation: '',
        authorizedMemoryContext: '',
        grantedCapabilities: ['model:invoke'],
        skillVersionIds: [],
      }),
      nativeSkills,
      baseSkillCatalog: {
        schemaVersion: 1,
        authority: 'skills/catalog.json',
        catalogChecksum: catalog.catalogChecksum,
        snapshotChecksum: runtimePolicyDigest({ skills, nativeSkills }),
        skills,
      },
      providerSnapshot: {
        provider: 'dsh',
        authMode: 'allrice_credential',
        route: 'openai-compatible',
        model: 'p24-synthetic',
        reasoningEffort: 'high',
        credentialReference: 'test:synthetic',
        baseUrl: model.baseUrl,
      },
      storageObjects: [],
      workDirectory: model.root,
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
      tools: [],
      authorizedToolNames: [],
      onEvent: async (e) => {
        events.push(e);
      },
    });
    expect(
      validateExperienceDraftOutput(JSON.parse(result.answer), [sourceId]),
    ).toEqual(output);
    expect(model.requests).toHaveLength(2);
    expect(JSON.stringify(model.requests[1])).toContain('最多提出 8 条草稿');
    const names = model.requests[0]!.tools!.map((t) => t.function.name);
    expect(names).toContain('skill');
    expect(
      names.some((n) =>
        /workspace|local|python|assistant|file|execute|shell/.test(n),
      ),
    ).toBe(false);
    expect(
      events.every(
        (e) =>
          HarnessEventSchema.safeParse(e).success &&
          e.sessionId === null &&
          e.messageId === null &&
          e.internalTask?.occurrenceId === occurrenceId,
      ),
    ).toBe(true);
    const loaded = events.find(
      (e) => e.type === 'tool.completed' && e.name === 'skill',
    )!;
    expect(normalizeHarnessRunEvent(loaded)).toMatchObject({
      type: 'tool.completed',
      payload: {
        internalTask: { kind: 'experience_consolidation', occurrenceId },
        nativePayload: {
          skillStatus: 'loaded',
          skillId: entry.id,
          skillVersion: entry.version,
          skillChecksum: entry.checksum,
          skillCatalogChecksum: catalog.catalogChecksum,
        },
      },
    });
    expect(adapter.runtimeInventory()[0]).toMatchObject({
      sessionId: null,
      internalTask: { kind: 'experience_consolidation', occurrenceId },
    });
  } finally {
    await adapter.close();
    await model.close();
  }
}, 30000);
