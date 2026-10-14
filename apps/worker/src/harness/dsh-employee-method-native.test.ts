import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  EmployeeMethodInspectSchema,
  EmployeeMethodPrepareActivationSchema,
  EmployeeMethodActivateSchema,
  EmployeeMethodFileStepSchema,
  EmployeeMethodSaveSchema,
  EmployeeMethodTestStartSchema,
  EmployeeMethodTestInspectSchema,
} from '@allrice/contracts';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';

it.each([
  {
    canonicalName: 'workspace.employee.method.prepare_activation',
    wireName: 'workspace_employee_method_prepare_activation',
    schema: EmployeeMethodPrepareActivationSchema,
    args: {
      expectedRevision: 3,
      candidateRevisionId: '00000000-0000-4000-8000-000000000001',
      candidateDigest: `sha256:${'a'.repeat(64)}`,
      testIds: ['00000000-0000-4000-8000-000000000002'],
    },
  },
  {
    canonicalName: 'workspace.employee.method.activate',
    wireName: 'workspace_employee_method_activate',
    schema: EmployeeMethodActivateSchema,
    args: { receiptId: '00000000-0000-4000-8000-000000000003' },
  },
  {
    canonicalName: 'platform.employee.method.step',
    wireName: 'platform_employee_method_step',
    schema: EmployeeMethodFileStepSchema,
    args: {
      stage: 'normalize',
      script:
        "import fs from 'node:fs'; console.log(fs.readFileSync('input/amounts.csv','utf8'));",
    },
  },
  {
    canonicalName: 'workspace.employee.method.test',
    wireName: 'workspace_employee_method_test',
    schema: EmployeeMethodTestStartSchema,
    args: {
      expectedRevision: 1,
      candidateRevisionId: '00000000-0000-4000-8000-000000000001',
      candidateDigest: `sha256:${'a'.repeat(64)}`,
      sceneId: '00000000-0000-4000-8000-000000000002',
      caseId: 'cny-file-flow-v1',
    },
  },
  {
    canonicalName: 'workspace.employee.method.test',
    wireName: 'workspace_employee_method_test',
    schema: EmployeeMethodTestStartSchema,
    args: {
      expectedRevision: 1,
      candidateRevisionId: '00000000-0000-4000-8000-000000000001',
      candidateDigest: `sha256:${'a'.repeat(64)}`,
      sceneId: '00000000-0000-4000-8000-000000000002',
      caseId: 'cny-total-v1',
      retryOfTestId: '00000000-0000-4000-8000-000000000003',
    },
  },
  {
    canonicalName: 'workspace.employee.method.test',
    wireName: 'workspace_employee_method_test',
    schema: EmployeeMethodTestStartSchema,
    args: {
      expectedRevision: 1,
      candidateRevisionId: '00000000-0000-4000-8000-000000000001',
      candidateDigest: `sha256:${'a'.repeat(64)}`,
      sceneId: '00000000-0000-4000-8000-000000000002',
      caseId: 'cny-total-v1',
    },
  },
  {
    canonicalName: 'workspace.employee.method.test_status',
    wireName: 'workspace_employee_method_test_status',
    schema: EmployeeMethodTestInspectSchema,
    args: { testId: '00000000-0000-4000-8000-000000000003' },
  },
])(
  'roundtrips exact candidate test parameters without model-supplied expectations: $wireName',
  async ({ schema, ...test }) => {
    await nativeBrokerRoundtrip({
      ...test,
      invalidArgs: { ...test.args, expected: 30100 },
      inspectSchema(nativeSchema) {
        const contract = z.toJSONSchema(schema);
        // Inspect what the real DSH process sent to the provider, not just
        // whether its validator accepts a preconstructed tool call.
        expect(Object.keys(nativeSchema.properties as object).sort()).toEqual(
          Object.keys(contract.properties ?? {}).sort(),
        );
        expect((nativeSchema.required as string[]).toSorted()).toEqual(
          (contract.required ?? []).toSorted(),
        );
      },
      onToolCall: async (call) => {
        expect(schema.parse(call.arguments)).toEqual(test.args);
        return {
          modelContent: JSON.stringify({
            status: 'queued',
            validationStatus: 'pending',
            retryOfTestId:
              'retryOfTestId' in test.args ? test.args.retryOfTestId : null,
            retryTestId: null,
            currency: 'CNY',
            amountUnit: 'cent',
          }),
          summary: 'Queued',
        };
      },
    });
  },
  45000,
);

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
    replaceTextReferences: [
      {
        sourceKind: 'procedure',
        contentId: '00000000-0000-4000-8000-000000000004',
        revisionId: '00000000-0000-4000-8000-000000000005',
        digest: `sha256:${'b'.repeat(64)}`,
      },
    ],
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
        'operation',
        'procedure',
        'references',
        'removeReferences',
        'replaceTextReferences',
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

it.each([
  {
    operation: 'remove_scene',
    scene: { id: '00000000-0000-4000-8000-000000000001' },
  },
  { scene: { id: '00000000-0000-4000-8000-000000000001', name: '周度回款' } },
  {
    scene: { id: '00000000-0000-4000-8000-000000000001' },
    removeReferences: [
      {
        sourceKind: 'knowledge',
        contentId: '00000000-0000-4000-8000-000000000002',
        revisionId: '00000000-0000-4000-8000-000000000003',
        digest: `sha256:${'a'.repeat(64)}`,
      },
    ],
  },
])(
  'roundtrips candidate lifecycle edits through native DSH: %j',
  async (edit) => {
    const args = {
      expectedRevision: 3,
      section: 'scene',
      changeSummary: '候选调整，尚未启用',
      ...edit,
    };
    await nativeBrokerRoundtrip({
      canonicalName: 'workspace.employee.method.save_candidate',
      wireName: 'workspace_employee_method_save_candidate',
      args,
      invalidArgs: { ...args, ownerId: 'foreign' },
      onToolCall: async (call) => {
        expect(EmployeeMethodSaveSchema.parse(call.arguments)).toEqual(args);
        return {
          modelContent: '{"revision":4,"enabled":false}',
          summary: 'Candidate edited',
        };
      },
    });
  },
  45000,
);
