import { expect, it } from 'vitest';
import { EmployeeProfileChatInputSchema } from '@allrice/contracts';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';

it.each([true, false])(
  'roundtrips the personal-profile schema through native DSH (custom name=%s) without owner or authority fields',
  async (custom) => {
    const args = {
      expectedRevision: 1,
      ...(custom ? { name: '小禾' } : {}),
      expressionStyle: 'concise',
    };
    await nativeBrokerRoundtrip({
      canonicalName: 'workspace.employee.profile.update',
      wireName: 'workspace_employee_profile_update',
      args,
      invalidArgs: { ...args, ownerId: '00000000-0000-4000-8000-000000000001' },
      inspectSchema(schema) {
        expect(Object.keys(schema.properties as object).sort()).toEqual([
          'expectedRevision',
          'expressionStyle',
          'name',
        ]);
      },
      onToolCall: async (call) => {
        expect(EmployeeProfileChatInputSchema.parse(call.arguments)).toEqual(
          args,
        );
        return {
          modelContent: JSON.stringify({
            revision: 2,
            effectiveFrom: 'next_task',
          }),
          summary: 'Personal profile updated',
        };
      },
    });
  },
  45000,
);
