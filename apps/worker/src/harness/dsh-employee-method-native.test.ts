import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  EmployeeMethodInspectSchema,
  EmployeeMethodPrepareActivationSchema,
  EmployeeMethodActivateSchema,
  EmployeeMethodFileStepSchema,
  EmployeeMethodSaveSchema,
  EmployeeMethodRestoreSchema,
  EmployeeMethodTestStartSchema,
  EmployeeMethodTestInspectSchema,
} from '@allrice/contracts';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';

const departmentTarget = {
  scope: 'department',
  setId: '00000000-0000-4000-8000-000000000011',
  employeeId: '00000000-0000-4000-8000-000000000012',
  departmentId: '00000000-0000-4000-8000-000000000013',
};
const companyTarget = {
  scope: 'company',
  setId: departmentTarget.setId,
  employeeId: departmentTarget.employeeId,
};

it.each([
  { scope: 'company' },
  { scope: 'department', departmentId: departmentTarget.departmentId },
])(
  'preserves company publication target and distinct execution view through native schema: %s',
  async (executionView) => {
    const args = {
      sharedTarget: companyTarget,
      executionView,
      expectedRevision: 3,
      candidateRevisionId: '00000000-0000-4000-8000-000000000001',
      candidateDigest: `sha256:${'a'.repeat(64)}`,
      coverageDigest: `sha256:${'b'.repeat(64)}`,
      sceneId: '00000000-0000-4000-8000-000000000002',
      caseId: 'cny-total-v1',
    };
    await nativeBrokerRoundtrip({
      canonicalName: 'workspace.employee.method.test',
      wireName: 'workspace_employee_method_test',
      args,
      invalidArgs: {
        ...args,
        executionView: { ...executionView, ownerId: departmentTarget.setId },
      },
      onToolCall: async (call) => {
        expect(EmployeeMethodTestStartSchema.parse(call.arguments)).toEqual(
          args,
        );
        return {
          modelContent: JSON.stringify({
            executionView,
            sharedTarget: companyTarget,
          }),
          summary: 'Shared execution view retained',
        };
      },
    });
  },
  45000,
);

it('roundtrips candidate test pagination without turning a historical status into a passing proof', async () => {
  const args = {
    view: 'candidate',
    scope: 'company',
    beforeTestId: '00000000-0000-4000-8000-000000000001',
  };
  await nativeBrokerRoundtrip({
    canonicalName: 'workspace.employee.method.inspect',
    wireName: 'workspace_employee_method_inspect',
    args,
    invalidArgs: { ...args, ownerId: departmentTarget.setId },
    onToolCall: async (call) => {
      expect(EmployeeMethodInspectSchema.parse(call.arguments)).toEqual(args);
      return {
        modelContent: JSON.stringify({
          candidateTests: [],
          nextBeforeTestId: null,
        }),
        summary: 'Scoped candidate discovery',
      };
    },
  });
}, 45000);

it('roundtrips server coverage digest for a department common candidate through the native provider schema', async () => {
  const args = {
    sharedTarget: departmentTarget,
    expectedRevision: 3,
    candidateRevisionId: '00000000-0000-4000-8000-000000000001',
    candidateDigest: `sha256:${'a'.repeat(64)}`,
    coverageDigest: `sha256:${'b'.repeat(64)}`,
    sceneId: '00000000-0000-4000-8000-000000000002',
    caseId: 'cny-total-v1',
  };
  await nativeBrokerRoundtrip({
    canonicalName: 'workspace.employee.method.test',
    wireName: 'workspace_employee_method_test',
    args,
    invalidArgs: { ...args, requiredSceneIds: [args.sceneId] },
    inspectSchema(schema) {
      expect(schema).toMatchObject({
        properties: { coverageDigest: { type: 'string' } },
      });
    },
    onToolCall: async (call) => {
      expect(EmployeeMethodTestStartSchema.parse(call.arguments)).toEqual(args);
      return {
        modelContent: JSON.stringify({ coverageDigest: args.coverageDigest }),
        summary: 'Server coverage preserved',
      };
    },
  });
}, 45000);

it.each([companyTarget, departmentTarget])(
  'restoration preserves exact shared scope through native broker: %s',
  async (target) => {
    const args = {
      sharedTarget: target,
      expectedRevision: 4,
      sourceRevisionId: '00000000-0000-4000-8000-000000000001',
      changeSummary: 'Restore exact shared history',
    };
    await nativeBrokerRoundtrip({
      canonicalName: 'workspace.employee.method.restore_candidate',
      wireName: 'workspace_employee_method_restore_candidate',
      args,
      invalidArgs: { ...args, enabled: true },
      onToolCall: async (call) => {
        expect(EmployeeMethodRestoreSchema.parse(call.arguments)).toEqual(args);
        return {
          modelContent: JSON.stringify({ restored: true, enabled: false }),
          summary: 'Shared restoration selection retained',
        };
      },
    });
  },
  45000,
);

it.each([
  {
    canonicalName: 'workspace.employee.method.inspect',
    wireName: 'workspace_employee_method_inspect',
    schema: EmployeeMethodInspectSchema,
    args: { view: 'candidate', scope: 'company' },
  },
  {
    canonicalName: 'workspace.employee.method.save_candidate',
    wireName: 'workspace_employee_method_save_candidate',
    schema: EmployeeMethodSaveSchema,
    args: {
      sharedTarget: companyTarget,
      expectedRevision: 0,
      section: 'scene',
      scene: { name: '金额合计', appliesWhen: '公司合成金额汇总' },
      procedure: '整数分相加',
      changeSummary: 'Company candidate',
    },
  },
  {
    canonicalName: 'workspace.employee.method.test',
    wireName: 'workspace_employee_method_test',
    schema: EmployeeMethodTestStartSchema,
    args: {
      sharedTarget: companyTarget,
      expectedRevision: 1,
      candidateRevisionId: '00000000-0000-4000-8000-000000000001',
      candidateDigest: `sha256:${'a'.repeat(64)}`,
      sceneId: '00000000-0000-4000-8000-000000000002',
      caseId: 'cny-total-v1',
    },
  },
  {
    canonicalName: 'workspace.employee.method.prepare_activation',
    wireName: 'workspace_employee_method_prepare_activation',
    schema: EmployeeMethodPrepareActivationSchema,
    args: {
      sharedTarget: companyTarget,
      expectedRevision: 1,
      candidateRevisionId: '00000000-0000-4000-8000-000000000001',
      candidateDigest: `sha256:${'a'.repeat(64)}`,
      testIds: ['00000000-0000-4000-8000-000000000002'],
    },
  },
])(
  'actual provider schema and broker preserve company selection: $canonicalName',
  async (test) => {
    await nativeBrokerRoundtrip({
      canonicalName: test.canonicalName,
      wireName: test.wireName,
      args: test.args,
      invalidArgs:
        'sharedTarget' in test.args
          ? {
              ...test.args,
              sharedTarget: {
                ...companyTarget,
                departmentId: departmentTarget.departmentId,
              },
            }
          : { ...test.args, departmentId: departmentTarget.departmentId },
      inspectSchema(schema) {
        const properties = schema.properties as Record<
          string,
          Record<string, unknown>
        >;
        if ('sharedTarget' in test.args) {
          const target = properties.sharedTarget!;
          expect(target.required).toEqual(
            expect.arrayContaining(['scope', 'setId', 'employeeId']),
          );
          expect(target.required).not.toContain('departmentId');
          expect(
            (target.properties as Record<string, { enum?: string[] }>).scope!
              .enum,
          ).toContain('company');
        } else expect(properties.scope!.enum).toContain('company');
      },
      onToolCall: async (call) => {
        expect(test.schema.parse(call.arguments)).toEqual(test.args);
        return {
          modelContent: '{"scope":"company","enabled":false}',
          summary: 'Company selection retained',
        };
      },
    });
  },
  45000,
);

it.each([
  {
    canonicalName: 'workspace.employee.method.inspect',
    wireName: 'workspace_employee_method_inspect',
    schema: EmployeeMethodInspectSchema,
    args: {
      view: 'candidate',
      scope: 'department',
      departmentId: departmentTarget.departmentId,
    },
  },
  {
    canonicalName: 'workspace.employee.method.save_candidate',
    wireName: 'workspace_employee_method_save_candidate',
    schema: EmployeeMethodSaveSchema,
    args: {
      sharedTarget: departmentTarget,
      expectedRevision: 0,
      section: 'scene',
      scene: { name: '金额合计', appliesWhen: '本部门金额汇总' },
      procedure: '整数分相加',
      changeSummary: 'Department text candidate',
    },
  },
  {
    canonicalName: 'workspace.employee.method.test',
    wireName: 'workspace_employee_method_test',
    schema: EmployeeMethodTestStartSchema,
    args: {
      sharedTarget: departmentTarget,
      expectedRevision: 1,
      candidateRevisionId: '00000000-0000-4000-8000-000000000001',
      candidateDigest: `sha256:${'a'.repeat(64)}`,
      sceneId: '00000000-0000-4000-8000-000000000002',
      caseId: 'cny-total-v1',
    },
  },
  {
    canonicalName: 'workspace.employee.method.prepare_activation',
    wireName: 'workspace_employee_method_prepare_activation',
    schema: EmployeeMethodPrepareActivationSchema,
    args: {
      sharedTarget: departmentTarget,
      expectedRevision: 1,
      candidateRevisionId: '00000000-0000-4000-8000-000000000001',
      candidateDigest: `sha256:${'a'.repeat(64)}`,
      testIds: ['00000000-0000-4000-8000-000000000002'],
    },
  },
  {
    canonicalName: 'workspace.employee.method.restore_candidate',
    wireName: 'workspace_employee_method_restore_candidate',
    schema: EmployeeMethodRestoreSchema,
    args: {
      expectedRevision: 4,
      sourceRevisionId: '00000000-0000-4000-8000-000000000001',
      changeSummary: 'Restore entire personal method to revision 1',
    },
  },
  {
    canonicalName: 'workspace.employee.method.inspect',
    wireName: 'workspace_employee_method_inspect',
    schema: EmployeeMethodInspectSchema,
    args: { view: 'history', beforeRevision: 4 },
  },
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
      expect(Object.keys(schema.properties as object).sort()).toEqual([
        'beforeRevision',
        'beforeTestId',
        'departmentId',
        'scope',
        'view',
      ]);
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
        'sharedTarget',
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
