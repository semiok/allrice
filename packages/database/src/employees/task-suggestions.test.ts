import { describe, expect, it } from 'vitest';
import {
  EmployeeDefinitionSchema,
  EmployeeManifestSchema,
  type EmployeeDefinition,
} from '@allrice/contracts';
import {
  employeeManifest,
  employeeManifestChecksum,
  riceManifest,
} from './employee-config.ts';
import {
  projectEmployeeTaskSuggestions,
  taskSuggestionConfigurationErrors,
} from './task-suggestions.ts';

function rice(): EmployeeDefinition {
  return EmployeeDefinitionSchema.parse(riceManifest());
}
describe('safe task display projection', () => {
  it('reads all four role types without changing legacy frozen manifests/checksums', () => {
    const manifest = rice(),
      bytes = JSON.stringify(manifest),
      checksum = employeeManifestChecksum(manifest);
    expect(Object.hasOwn(manifest, 'taskSuggestions')).toBe(false);
    const tasks = projectEmployeeTaskSuggestions(manifest);
    expect(tasks.map((task) => task.id)).toEqual(
      expect.arrayContaining([
        'organize-expenses',
        'draft-notice',
        'review-project',
        'review-literature',
      ]),
    );
    expect(tasks).toHaveLength(8);
    expect(JSON.stringify(tasks)).not.toMatch(
      /requires|nativeSkillIds|toolNames|credentialReference|runtimePackage|securityPolicy/,
    );
    expect(JSON.stringify(manifest)).toBe(bytes);
    expect(employeeManifestChecksum(manifest)).toBe(checksum);
  });
  it('matches tools/denials and never infers Office formats from the employee name', () => {
    const office = employeeManifest({
      key: 'office',
      name: 'Office',
      description: 'Legacy employee',
      toolNames: ['workspace.document.read'],
    });
    expect(
      projectEmployeeTaskSuggestions(office).some(
        (task) =>
          task.title.includes('Word') ||
          task.title.includes('Excel') ||
          task.title.includes('PPT'),
      ),
    ).toBe(false);
    const manifest = rice();
    manifest.capabilityBindings.toolNames = ['workspace.document.read'];
    expect(
      projectEmployeeTaskSuggestions(manifest).some(
        (task) => task.id === 'review-project',
      ),
    ).toBe(false);
    manifest.securityPolicy.deniedCapabilities.push('storage:read');
    expect(
      projectEmployeeTaskSuggestions(manifest).some(
        (task) => task.id === 'organize-materials',
      ),
    ).toBe(false);
    expect(
      projectEmployeeTaskSuggestions(manifest).some(
        (task) => task.id === 'make-plan',
      ),
    ).toBe(true);
  });
  it('honors explicit empty configuration and returns only safe display fields', () => {
    const manifest = rice();
    manifest.taskSuggestions = [];
    expect(projectEmployeeTaskSuggestions(manifest)).toEqual([]);
    manifest.taskSuggestions = [
      {
        id: 'local-project',
        title: '梳理项目',
        template: '只读梳理项目。',
        requires: { toolNames: ['local.fs.read'], readiness: ['local_files'] },
        preparation: ['bridge'],
      },
    ];
    expect(projectEmployeeTaskSuggestions(manifest)).toEqual([
      {
        id: 'local-project',
        title: '梳理项目',
        template: '只读梳理项目。',
        readiness: ['local_files'],
        preparation: ['bridge'],
      },
    ]);
    manifest.taskSuggestions[0]!.requires!.nativeSkillIds = [
      '11111111-1111-4111-8111-111111111111',
    ];
    expect(projectEmployeeTaskSuggestions(manifest)).toEqual([]);
  });
  it('reports exact admin correction locations without granting referenced tools', () => {
    const missing = '11111111-1111-4111-8111-111111111111';
    expect(
      taskSuggestionConfigurationErrors({
        taskSuggestions: [
          {
            id: 'review',
            title: '检查',
            template: '检查资料',
            requires: {
              toolNames: ['not.a.tool', 'web.search'],
              nativeSkillIds: [missing],
            },
          },
        ],
        capabilities: {
          nativeSkillIds: [],
          workflowRevisionIds: [],
          knowledgeRevisionIds: [],
          toolNames: [],
          connectorRefs: [],
        },
        securityPolicy: {
          dataScopes: ['workspace'],
          approvalPolicy: 'confirm_side_effects',
          bridgeAccess: 'none',
          connectorIdentityModes: [],
          deniedCapabilities: [],
        },
      }),
    ).toEqual([
      '基础 → 推荐任务 1（review） → 工具引用不存在：not.a.tool',
      '基础 → 推荐任务 1（review） → 员工未装配工具：web.search',
      `基础 → 推荐任务 1（review） → 员工未装配 Skill：${missing}`,
    ]);
  });
  it('keeps v1 model-capable definitions readable using only conversation tasks', () => {
    const current = rice();
    const legacy = EmployeeManifestSchema.parse({
      schemaVersion: 1,
      key: current.key,
      name: 'Rice',
      description: current.description,
      systemPrompt: current.systemPrompt,
      provider: current.provider,
      capabilities: ['model:invoke'],
      skillVersionIds: [],
      partnerProfile: current.partnerProfile,
    });
    const bytes = JSON.stringify(legacy);
    expect(
      projectEmployeeTaskSuggestions(legacy).map((task) => task.id),
    ).toEqual(['make-plan', 'write-summary', 'draft-notice', 'research-plan']);
    expect(
      projectEmployeeTaskSuggestions(legacy).every(
        (task) => !task.preparation?.length && !task.readiness?.length,
      ),
    ).toBe(true);
    expect(JSON.stringify(legacy)).toBe(bytes);
  });
});
