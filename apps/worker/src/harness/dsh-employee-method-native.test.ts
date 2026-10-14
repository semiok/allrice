import { expect, it } from 'vitest';
import {
  EmployeeMethodInspectSchema,
  EmployeeMethodSaveSchema,
} from '@allrice/contracts';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';

it('passes candidate view through actual native DSH and excludes target authority inputs', async () => {
  await nativeBrokerRoundtrip({
    canonicalName: 'workspace.employee.method.inspect',
    wireName: 'workspace_employee_method_inspect',
    args: { view: 'candidate' },
    invalidArgs: { view: 'candidate', instanceId: 'foreign' },
    inspectSchema(schema) {
      expect(Object.keys(schema.properties as object)).toEqual(['view']);
    },
    onToolCall: async (call) => {
      expect(EmployeeMethodInspectSchema.parse(call.arguments)).toEqual({
        view: 'candidate',
      });
      return {
        modelContent: '{"revision":0,"candidate":null}',
        summary: 'Candidate read',
      };
    },
  });
}, 45000);

it('roundtrips nested scene edits and pinned source references with no activation or owner fields', async () => {
  const args = {
    expectedRevision: 3,
    section: 'scene',
    scene: {
      id: '00000000-0000-4000-8000-000000000001',
      name: '月度核对',
      appliesWhen: '每月',
    },
    requirements: '核对期间',
    procedure: '先校验输入',
    changeSummary: '增加检查',
    references: [
      {
        sourceKind: 'knowledge',
        contentId: '00000000-0000-4000-8000-000000000002',
        revisionId: '00000000-0000-4000-8000-000000000003',
        digest: `sha256:${'a'.repeat(64)}`,
      },
    ],
  };
  await nativeBrokerRoundtrip({
    canonicalName: 'workspace.employee.method.save_candidate',
    wireName: 'workspace_employee_method_save_candidate',
    args,
    invalidArgs: { ...args, activate: true },
    inspectSchema(schema) {
      expect(Object.keys(schema.properties as object).sort()).toEqual([
        'changeSummary',
        'expectedRevision',
        'procedure',
        'references',
        'requirements',
        'scene',
        'section',
      ]);
    },
    onToolCall: async (call) => {
      expect(EmployeeMethodSaveSchema.parse(call.arguments)).toEqual(args);
      return {
        modelContent: '{"revision":4,"enabled":false}',
        summary: 'Candidate saved',
      };
    },
  });
}, 45000);
