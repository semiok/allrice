import { expect, it } from 'vitest';
import { PersonalSkillVersionInputSchema } from '@allrice/contracts';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';
import { HandlerError } from '../errors.js';
const id = '00000000-0000-4000-8000-000000000011';
it('preserves temporary skill contention as a failed native tool with recovery guidance', async () => {
  const message = '技能状态暂时繁忙，请稍后重试查询当前状态，再继续原操作。';
  await nativeBrokerRoundtrip({
    canonicalName: 'workspace.personal_skill.version',
    wireName: 'workspace_personal_skill_version',
    args: { operation: 'inspect' },
    invalidArgs: { operation: 'inspect', ownerId: id },
    expectedToolError: message,
    onToolCall: async () => {
      throw new HandlerError('PERSONAL_SKILL_BUSY', message, false);
    },
  });
}, 45000);
it.each([
  { operation: 'inspect' },
  {
    operation: 'update',
    installationId: id,
    expectedRevision: 1,
    objectId: id,
  },
  {
    operation: 'update',
    installationId: id,
    expectedRevision: 1,
    url: 'https://github.com/acme/skills/tree/main/weekly',
  },
  {
    operation: 'rollback',
    installationId: id,
    expectedRevision: 2,
    version: 1,
  },
  { operation: 'confirm', operationId: id, digest: `sha256:${'a'.repeat(64)}` },
  { operation: 'bind', installationId: id, expectedRevision: 2, versionId: id },
])(
  'preserves personal version arguments through native DSH: %j',
  async (args) => {
    await nativeBrokerRoundtrip({
      canonicalName: 'workspace.personal_skill.version',
      wireName: 'workspace_personal_skill_version',
      args,
      invalidArgs: { ...args, ownerId: id },
      inspectSchema(schema) {
        expect(Object.keys(schema.properties as object).sort()).toEqual([
          'digest',
          'expectedRevision',
          'installationId',
          'objectId',
          'operation',
          'operationId',
          'url',
          'version',
          'versionId',
        ]);
      },
      async onToolCall(call) {
        expect(PersonalSkillVersionInputSchema.parse(call.arguments)).toEqual(
          args,
        );
        return {
          modelContent: JSON.stringify({
            status: 'confirmation_required',
            effectiveFrom: 'next_task',
          }),
          summary: 'Fixed private version preview',
        };
      },
    });
  },
  45000,
);
