/** Actual ordinary DSH adapter with synthetic provider and personal Skill content. */
import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';
import {
  EmployeeKernelRequestSchema,
  type HarnessEvent,
  type PersonalSkillPin,
} from '@allrice/contracts';
import { skillBytesChecksum } from '../../../../packages/database/src/skill-bundles.ts';
import { runtimePolicyDigest } from '../../../../packages/database/src/runtime-policy.ts';
import { p24Fixture } from '../p24/fixture.js';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.js';
/** Synthetic instructions only; never imports private user Skill content. */
function personalSkillFixture(identity: Partial<PersonalSkillPin> = {}) {
  const content =
    '# Attendance counting\n核对原始名单中的到场、未到人数与成员，分别列出。缺少名单或状态不明时说明缺失，不推算。';
  const definition = {
    name: 'attendance-counting',
    description: '核对有明确状态的合成名单。',
    content,
    checksum: skillBytesChecksum(content),
    invocation: { modelInvocable: true, userInvocable: true },
  };
  const pin: PersonalSkillPin = {
    organizationId: randomUUID(),
    ownerId: randomUUID(),
    instanceId: randomUUID(),
    installationId: randomUUID(),
    versionId: randomUUID(),
    bindingId: randomUUID(),
    bindingEpoch: 1,
    definitionChecksum: runtimePolicyDigest(definition),
    ...identity,
  };
  const index = {
    schemaVersion: 1 as const,
    instanceId: pin.instanceId,
    skills: [pin],
  };
  return {
    pin,
    definition,
    personalSkills: { ...index, checksum: runtimePolicyDigest(index) },
    nativeSkill: {
      ...definition,
      id: pin.versionId,
      personal: pin,
      requiredToolRefs: [],
    },
  };
}

it.each([false, true])(
  'loads an exact personal Skill in the ordinary DSH runtime, guarding revocation (%s)',
  async (revoked) => {
    const skill = personalSkillFixture(),
      testId = randomUUID();
    let revoke = false,
      checks = 0;
    const model = await p24Fixture(async (_request, index) => {
      if (index === 1) {
        revoke = revoked;
        return {
          nativeTool: {
            name: 'skill',
            arguments: { name: skill.nativeSkill.name },
          },
        };
      }
      return { text: 'SYNTHETIC_SKILL_RESULT' };
    });
    const events: HarnessEvent[] = [];
    const sessionId = randomUUID(),
      userMessageId = randomUUID(),
      assistantMessageId = randomUUID();
    const adapter = new DshHarnessAdapter({
      runtimeRoot: model.root,
      credentialResolver: {
        resolve: async () => ({ apiKey: 'synthetic-only' }),
      },
      requestTimeoutMs: 15000,
    });
    try {
      const runId = randomUUID(),
        jobId = randomUUID();
      const result = await adapter
        .execute({
          kernel: EmployeeKernelRequestSchema.parse({
            schemaVersion: 1,
            harness: 'dsh',
            employeeAssignmentId: randomUUID(),
            employeeVersionId: randomUUID(),
            sessionId,
            userMessageId,
            assistantMessageId,
            employeeDocuments: { schemaVersion: 2, user: '', memory: '' },
            systemInstructions:
              'Load attendance-counting. Then return the fixed attendance result.',
            userRequest: 'Synthetic roster',
            bootstrapConversation: '',
            authorizedMemoryContext: '',
            grantedCapabilities: ['model:invoke'],
            skillVersionIds: [skill.pin.versionId],
          }),
          nativeSkills: [skill.nativeSkill],
          tools: [],
          authorizedToolNames: [],
          storageObjects: [],
          workDirectory: model.root,
          contentGuard: {
            generationId: testId,
            nativeContextKey: `personal-skill-${testId}`,
            check: async () => {
              checks++;
              if (revoke) throw Error('synthetic Skill revoked');
            },
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
          executionEnvironment: {
            ALLRICE_ORGANIZATION_ID: skill.pin.organizationId,
            ALLRICE_WORKSPACE_ID: randomUUID(),
            ALLRICE_OWNER_ID: skill.pin.ownerId,
            ALLRICE_RUN_ID: runId,
            ALLRICE_JOB_ID: jobId,
            ALLRICE_ATTEMPT: '1',
          },
          signal: AbortSignal.timeout(20000),
          attempt: 1,
          generation: 0,
          onEvent: async (e) => {
            events.push(e);
          },
        })
        .then((value) => ({ value, error: null }))
        .catch((error) => ({ value: null, error }));
      const loaded = events.filter(
        (e) =>
          e.type === 'tool.completed' &&
          e.name === 'skill' &&
          e.sourcePayload?.skillStatus === 'loaded',
      );
      expect(
        checks,
        result.error instanceof Error
          ? `Preparation error: ${result.error.name}: ${result.error.message}`
          : undefined,
      ).toBeGreaterThan(0);
      expect(
        events.every(
          (e) =>
            e.sessionId === sessionId &&
            e.messageId === assistantMessageId &&
            e.internalTask === undefined,
        ),
      ).toBe(true);
      const names = model.requests[0]!.tools!.map((t) => t.function.name);
      expect(names.sort()).toEqual([
        'ask_user_question',
        'skill',
        'todo_write',
      ]);
      if (revoked) {
        expect(loaded).toEqual([]);
        expect(JSON.stringify(model.requests)).not.toContain(
          skill.definition.content,
        );
        expect(result.error).toBeTruthy();
      } else {
        expect(result.error).toBeNull();
        expect(result.value!.answer).toBe('SYNTHETIC_SKILL_RESULT');
        expect(loaded).toHaveLength(1);
        expect(loaded[0]!.sourcePayload!.personalSkill).toEqual(skill.pin);
        expect(JSON.stringify(model.requests[1]!.messages)).toContain(
          '核对原始名单',
        );
      }
    } finally {
      await adapter.close();
      await model.close();
    }
  },
  30000,
);
