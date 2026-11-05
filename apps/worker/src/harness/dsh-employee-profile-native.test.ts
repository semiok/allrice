import { expect, it } from 'vitest';
import { EmployeeProfileChatInputSchema } from '@allrice/contracts';
import { employeeInstanceInstructions } from '../employee-kernel.js';
import { riceToolDefinitions } from '../tool-broker/definitions.js';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';

it.each(['rice', 'custom', 'professional'] as const)(
  'exposes a profile contract consistent with the frozen %s kernel through native DSH, without owner or authority inputs',
  async (identity) => {
    const personalName = identity !== 'professional';
    const snapshot = {
      schemaVersion: 2,
      employee: {
        key: identity === 'professional' ? 'professional' : 'default-assistant',
        versionId: 'version',
        definition: {
          schemaVersion: 2,
          key: 'default-assistant',
          isDefaultRice: true,
        },
      },
      instance: {
        kind: identity === 'custom' ? 'custom' : 'general',
        source: { kind: 'platform', employeeVersionId: 'version' },
        revision: 1,
        // Even a professional employee called Rice must remain style-only.
        profile: { name: 'Rice' },
      },
      capabilitySnapshot: {
        bindings: { toolNames: ['workspace.employee.profile.update'] },
      },
    } as unknown as Parameters<typeof employeeInstanceInstructions>[0];
    const systemPrompt = employeeInstanceInstructions(snapshot).join('\n');
    if (personalName) {
      expect(systemPrompt).toContain(
        'save the personal display name or default expression style',
      );
      expect(systemPrompt).not.toContain('do not send name');
    } else {
      expect(systemPrompt).toContain(
        'do not send name or edit business methods',
      );
      expect(systemPrompt).not.toContain('Your personal display name is');
    }
    const args = {
      expectedRevision: 1,
      ...(personalName ? { name: '小米' } : {}),
      expressionStyle: 'concise',
    };
    await nativeBrokerRoundtrip({
      systemPrompt,
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
      inspectTool(tool) {
        // Inspect what the real DSH runtime sent to the loopback provider,
        // not a duplicate tool definition or just the kernel string.
        expect(tool.description).toContain(
          "The owner's basic Rice instance and personal custom AI employee accept name and expressionStyle",
        );
        expect(tool.description).toContain(
          'professional general employees accept expressionStyle only',
        );
        expect(tool.description).toContain(
          'server authorization authoritative',
        );
        const properties = tool.parameters!.properties as Record<
          string,
          { description: string }
        >;
        expect(properties.name!.description).toContain(
          'basic Rice instance or personal custom AI employee',
        );
        expect(properties.name!.description).toContain(
          'Never send name for a platform-provided professional general employee',
        );
        expect(properties.name!.description).toContain(
          'frozen instance identity and source',
        );
        const broker = riceToolDefinitions.find(
          (tool) => tool.name === 'workspace.employee.profile.update',
        )!;
        expect(broker.description).toContain(
          '本人基础 Rice 和本人定制员工允许 name、expressionStyle',
        );
        expect(broker.description).toContain(
          '后台配发的专业通用员工只允许 expressionStyle',
        );
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
