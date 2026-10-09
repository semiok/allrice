import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PLATFORM_EMPLOYEE_DSH_APPROVED_PLUGINS,
  PLATFORM_EMPLOYEE_DSH_DISTRIBUTION,
  PlatformEmployeeRuntimeProfileSchema,
  PlatformEmployeeDefinitionSchema,
} from '@allrice/contracts';
import { describe, expect, it } from 'vitest';

import type { PlatformEmployeeDefinition } from '@allrice/contracts';

import { employeeManifest } from './employee-config.js';
import { frozenPackageSkills } from './skill-bundles.ts';
import { projectEmployeeTaskSuggestions } from './employees/task-suggestions.ts';
import { loadPlatformContentCatalog } from './platform-content/catalog.js';
import {
  buildEmployeeRuntimePackage,
  platformEmployeeTestCanFinalize,
  platformEmployeeTestExecutionTerminalState,
  platformEmployeeTestTimeoutAt,
  runtimePackageSystemPrompt,
  validatePlatformEmployeeTestExecutionSnapshot,
} from './platform-employees.js';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const previewSnapshotMigration = readFileSync(
  resolve(
    repositoryRoot,
    'packages/database/migrations/0066_platform_employee_preview_snapshots.sql',
  ),
  'utf8',
);

const definition: PlatformEmployeeDefinition = {
  schemaVersion: 1,
  key: 'rice',
  name: 'Rice',
  description: 'AllRice 默认通用 AI 员工。',
  appearance: { avatarType: 'initials', avatarValue: 'R' },
  identity: {
    role: '通用工作伙伴',
    mission: '理解目标并推进工作。',
    workStyle: '结论优先，结构化推进。',
    behaviorRules: ['不编造执行结果。'],
    safetyBoundaries: ['只使用已授权数据。'],
    expressionStyle: 'structured',
    outputLanguage: 'zh-CN',
  },
  systemPrompt: '遵守 AllRice 平台硬边界。',
  modelPolicy: {
    provider: 'openai-codex',
    model: 'gpt-5.6-luna',
    reasoningEffort: 'xhigh',
    timeoutMs: 300_000,
    fallbackModels: [],
    credentialReference: 'deployment:codex-default',
    baseUrl: null,
  },
  capabilities: {
    nativeSkillIds: ['10000000-0000-4000-8000-000000000001'],
    workflowRevisionIds: [],
    knowledgeRevisionIds: [],
    toolNames: ['web.search'],
    connectorRefs: [],
  },
  securityPolicy: {
    dataScopes: ['workspace', 'employee', 'user'],
    approvalPolicy: 'confirm_side_effects',
    bridgeAccess: 'read_only',
    connectorIdentityModes: ['user'],
    deniedCapabilities: ['secret:use'],
  },
};

const skills = [
  {
    id: '10000000-0000-4000-8000-000000000001',
    name: 'web-research',
    description: '检索并核验最新公开信息。',
    content: '# Web Research\n\n先搜索，再交叉核验并附来源。',
    checksum: `sha256:${createHash('sha256').update('# Web Research\n\n先搜索，再交叉核验并附来源。').digest('hex')}`,
    model_invocable: true,
    user_invocable: true,
    required_tool_refs: ['web.search'],
    source: 'allrice' as const,
    source_ref:
      'https://github.com/semiok/allrice/tree/main/skills/web-research',
    version: '1.0.0',
    license: 'Apache-2.0',
    review_status: 'reviewed' as const,
    reviewed_by_label: 'platform-admin',
    reviewed_at: new Date('2026-08-31T00:00:00.000Z'),
  },
];

it('keeps legacy definition bytes and runtime identity independent of tool selection provenance', () => {
  const legacy = PlatformEmployeeDefinitionSchema.parse(definition);
  expect(Object.hasOwn(legacy.capabilities, 'explicitToolNames')).toBe(false);
  expect(Object.hasOwn(legacy, 'taskSuggestions')).toBe(false);
  expect(legacy).toEqual(definition);
  const original = buildEmployeeRuntimePackage({
    revision: 7,
    definition: legacy,
    skills,
  });
  const edited = structuredClone(legacy);
  edited.capabilities.explicitToolNames = ['web.search'];
  expect(
    buildEmployeeRuntimePackage({ revision: 7, definition: edited, skills }),
  ).toEqual(original);
  expect(frozenPackageSkills(original)).toHaveLength(1);
});

it('keeps task display metadata out of runtime package/checksum and system prompt', () => {
  const original = buildEmployeeRuntimePackage({
    revision: 7,
    definition,
    skills,
  });
  const edited = {
    ...definition,
    taskSuggestions: [
      {
        id: 'unique-display-marker',
        title: '仅展示标题',
        template: '仅展示草稿 unique-display-marker',
      },
    ],
  };
  expect(
    buildEmployeeRuntimePackage({ revision: 7, definition: edited, skills }),
  ).toEqual(original);
  expect(
    runtimePackageSystemPrompt({
      platformPolicy: edited.systemPrompt,
      runtimePackage: original,
    }),
  ).not.toContain('unique-display-marker');
  expect(PlatformEmployeeDefinitionSchema.parse(definition)).toEqual(
    definition,
  );
});

it('projects Office formats only from the actual frozen native Skill and granted export tools', () => {
  const tools = [
    'workspace.skill.read',
    'workspace.document.read',
    'workspace.export.create',
  ];
  const officeDefinition = {
    ...definition,
    key: 'office',
    name: 'Office',
    capabilities: { ...definition.capabilities, toolNames: tools },
  };
  const officeSkills = [
    { ...skills[0]!, name: 'office', required_tool_refs: tools },
  ];
  const runtimePackage = buildEmployeeRuntimePackage({
    revision: 7,
    definition: officeDefinition,
    skills: officeSkills,
  });
  const manifest = employeeManifest({
    key: 'office',
    name: 'Office',
    description: 'Synthetic Office',
    runtimePackage,
    toolNames: tools,
  });
  const projected = projectEmployeeTaskSuggestions(manifest);
  expect(projected.map((task) => task.id)).toEqual(
    expect.arrayContaining([
      'office-word-report',
      'office-excel-table',
      'office-ppt-report',
      'office-word-notice',
      'office-research-report',
    ]),
  );
  expect(JSON.stringify(projected)).not.toMatch(
    /requires|nativeSkillIds|toolNames|securityPolicy|runtimePackage/,
  );
  if (manifest.schemaVersion !== 2) throw Error('expected v2');
  manifest.capabilityBindings.toolNames = tools.filter(
    (tool) => tool !== 'workspace.export.create',
  );
  expect(
    projectEmployeeTaskSuggestions(manifest).some((task) =>
      task.id.startsWith('office-'),
    ),
  ).toBe(false);
});

it('projects development and iteration tasks only from a frozen project Skill and actual tools', () => {
  const skillTools = ['workspace.project', 'workspace.skill.read'];
  const tools = [...skillTools, 'local.process.execute'];
  const projectDefinition = {
    ...definition,
    capabilities: { ...definition.capabilities, toolNames: tools },
  };
  const runtimePackage = buildEmployeeRuntimePackage({
    revision: 7,
    definition: projectDefinition,
    skills: [
      {
        ...skills[0]!,
        name: 'project-development',
        required_tool_refs: skillTools,
      },
    ],
  });
  const manifest = employeeManifest({
    key: 'project-helper',
    name: '普通项目伙伴',
    description: 'Synthetic frozen project employee',
    runtimePackage,
    toolNames: tools,
  });
  if (manifest.schemaVersion !== 2) throw Error('current employee required');
  const before = JSON.stringify(manifest);
  const tasks = projectEmployeeTaskSuggestions(manifest);
  expect(tasks.slice(0, 2).map((task) => task.id)).toEqual([
    'develop-project',
    'iterate-project',
  ]);
  expect(tasks.length).toBeLessThanOrEqual(8);
  // Cloud-capable projects must remain discoverable without a local Bridge.
  expect(
    tasks.slice(0, 2).some((task) => task.preparation?.includes('bridge')),
  ).toBe(false);
  expect(JSON.stringify(manifest)).toBe(before);
  const withoutSkill = structuredClone(manifest);
  withoutSkill.runtimePackage!.skills = [];
  expect(
    projectEmployeeTaskSuggestions(withoutSkill).map((task) => task.id),
  ).not.toContain('develop-project');
  const withoutTool = structuredClone(manifest);
  withoutTool.capabilityBindings.toolNames = ['workspace.skill.read'];
  expect(
    projectEmployeeTaskSuggestions(withoutTool).map((task) => task.id),
  ).not.toContain('develop-project');
  const noExecution = structuredClone(manifest);
  noExecution.capabilityBindings.toolNames = skillTools;
  expect(
    projectEmployeeTaskSuggestions(noExecution).map((task) => task.id),
  ).not.toContain('develop-project');
  const cloudOnly = structuredClone(manifest);
  cloudOnly.capabilityBindings.toolNames = [
    ...skillTools,
    'cloud.process.execute',
  ];
  expect(
    projectEmployeeTaskSuggestions(cloudOnly)
      .slice(0, 2)
      .map((task) => task.id),
  ).toEqual(['develop-project', 'iterate-project']);
  const explicit = structuredClone(manifest);
  explicit.taskSuggestions = [];
  expect(projectEmployeeTaskSuggestions(explicit)).toEqual([]);
});

it('offers reproducible research only with its frozen method, Office and executable Python permission', () => {
  const tools = [
    'workspace.document.read',
    'workspace.skill.read',
    'workspace.export.create',
    'python.execute',
  ];
  const scientificDefinition = {
    ...definition,
    capabilities: { ...definition.capabilities, toolNames: tools },
  };
  const runtimePackage = buildEmployeeRuntimePackage({
    revision: 7,
    definition: scientificDefinition,
    skills: [
      { ...skills[0]!, name: 'office', required_tool_refs: tools },
      {
        ...skills[0]!,
        id: 'b9a98b27-c04d-4d1d-a45d-c072fed4d6ca',
        name: 'scientific-analysis',
        required_tool_refs: tools,
      },
    ],
  });
  const manifest = employeeManifest({
    key: 'scientist',
    name: '科研人员',
    description: 'Synthetic frozen scientific employee',
    runtimePackage,
    toolNames: tools,
  });
  if (manifest.schemaVersion !== 2) throw Error('current employee required');
  const before = JSON.stringify(manifest);
  const ids = (value: typeof manifest) =>
    projectEmployeeTaskSuggestions(value).map((task) => task.id);
  expect(ids(manifest).slice(0, 2)).toEqual([
    'analyze-research-data',
    'iterate-research-analysis',
  ]);
  expect(projectEmployeeTaskSuggestions(manifest).length).toBeLessThanOrEqual(
    8,
  );
  expect(JSON.stringify(manifest)).toBe(before);
  for (const tool of tools) {
    const missing = structuredClone(manifest);
    missing.capabilityBindings.toolNames = tools.filter(
      (name) => name !== tool,
    );
    expect(ids(missing)).not.toContain('analyze-research-data');
    expect(ids(missing)).not.toContain('iterate-research-analysis');
  }
  for (const skill of ['office', 'scientific-analysis']) {
    const missing = structuredClone(manifest);
    missing.runtimePackage!.skills = missing.runtimePackage!.skills.filter(
      (value) => value.name !== skill,
    );
    expect(ids(missing)).not.toContain('analyze-research-data');
  }
  for (const capability of ['storage:read', 'storage:write'] as const) {
    const denied = structuredClone(manifest);
    denied.securityPolicy.deniedCapabilities.push(capability);
    expect(ids(denied)).not.toContain('analyze-research-data');
    const undeclared = structuredClone(manifest);
    undeclared.capabilities = undeclared.capabilities.filter(
      (value) => value !== capability,
    );
    expect(ids(undeclared)).not.toContain('analyze-research-data');
  }
  const explicit = structuredClone(manifest);
  explicit.taskSuggestions = [];
  expect(projectEmployeeTaskSuggestions(explicit)).toEqual([]);
});

it('offers finance tasks only with the frozen reconciliation script and all actual grants', async () => {
  const skill = (await loadPlatformContentCatalog()).skills.find(
    (value) => value.name === 'business-reconciliation',
  )!;
  const tools = skill.requiredToolRefs;
  const runtimePackage = buildEmployeeRuntimePackage({
    revision: 7,
    definition: {
      ...definition,
      capabilities: { ...definition.capabilities, toolNames: tools },
    },
    skills: [
      {
        ...skills[0]!,
        id: skill.id,
        name: skill.name,
        content: skill.content,
        checksum: skill.checksum,
        required_tool_refs: tools,
        bundle: skill.bundle,
      },
    ],
  });
  const manifest = employeeManifest({
    key: 'finance',
    name: '财务伙伴',
    description: 'Synthetic frozen finance employee without Office or Bridge',
    runtimePackage,
    toolNames: tools,
  });
  if (manifest.schemaVersion !== 2) throw Error('current employee required');
  const before = JSON.stringify(manifest);
  const financeIds = (value: typeof manifest) =>
    projectEmployeeTaskSuggestions(value)
      .map((task) => task.id)
      .filter((id) =>
        ['reconcile-payments', 'revise-reconciliation'].includes(id),
      );
  expect(financeIds(manifest)).toEqual([
    'reconcile-payments',
    'revise-reconciliation',
  ]);
  expect(JSON.stringify(manifest)).toBe(before);
  expect(JSON.stringify(projectEmployeeTaskSuggestions(manifest))).not.toMatch(
    /requires|nativeSkillIds|toolNames|runtimePackage|bridge/,
  );
  for (const tool of tools) {
    const missing = structuredClone(manifest);
    missing.capabilityBindings.toolNames = tools.filter(
      (name) => name !== tool,
    );
    expect(financeIds(missing)).toEqual([]);
  }
  for (const capability of ['storage:read', 'storage:write'] as const) {
    const denied = structuredClone(manifest);
    denied.securityPolicy.deniedCapabilities.push(capability);
    expect(financeIds(denied)).toEqual([]);
  }
  const withoutScript = structuredClone(manifest);
  withoutScript.runtimePackage!.skills[0]!.bundle!.resources = [];
  expect(financeIds(withoutScript)).toEqual([]);
  const withoutSkill = structuredClone(manifest);
  withoutSkill.runtimePackage!.skills = [];
  expect(financeIds(withoutSkill)).toEqual([]);
  const explicit = structuredClone(manifest);
  explicit.taskSuggestions = [];
  expect(financeIds(explicit)).toEqual([]);
});

function validFrozenExecutionSnapshot() {
  const content = '# Web Research\n\n先搜索，再交叉核验并附来源。';
  const validSkills = [
    {
      ...skills[0]!,
      content,
      checksum: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    },
  ];
  const runtimePackage = buildEmployeeRuntimePackage({
    revision: 7,
    definition,
    skills: validSkills,
  });
  const runtimeProfile = PlatformEmployeeRuntimeProfileSchema.parse({
    schemaVersion: 1,
    harness: 'dsh',
    distributionGeneration: PLATFORM_EMPLOYEE_DSH_DISTRIBUTION,
    approvedPluginIds: [...PLATFORM_EMPLOYEE_DSH_APPROVED_PLUGINS],
    employeeKey: definition.key,
    provider: definition.modelPolicy.provider,
    model: definition.modelPolicy.model,
    reasoningEffort: definition.modelPolicy.reasoningEffort,
    timeoutMs: definition.modelPolicy.timeoutMs,
    credentialReference: definition.modelPolicy.credentialReference,
    baseUrl: definition.modelPolicy.baseUrl,
    systemPrompt: runtimePackageSystemPrompt({
      platformPolicy: definition.systemPrompt,
      runtimePackage,
    }),
    nativeSkillIds: validSkills.map((skill) => skill.id),
    nativeSkillChecksums: validSkills.map((skill) => skill.checksum),
    toolNames: definition.capabilities.toolNames,
    connectorRefs: definition.capabilities.connectorRefs,
    securityPolicy: definition.securityPolicy,
    runtimePackage,
  });
  return {
    runtimeProfile,
    definition: structuredClone(definition),
    nativeSkills: structuredClone(runtimePackage.skills),
    packageChecksum: runtimePackage.checksum,
  };
}

function jsonbLikeRoundTrip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbLikeRoundTrip);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, jsonbLikeRoundTrip(nested)]),
    );
  }
  return value;
}

describe('platform employee runtime package', () => {
  it('uses the configured employee name and persona in each newly built identity', () => {
    const office = {
      ...definition,
      key: 'office',
      name: 'Office 文档助手',
      identity: {
        ...definition.identity,
        role: '文档助手',
        mission: '整理资料并制作报告、表格与演示文稿。',
      },
    };
    const first = buildEmployeeRuntimePackage({
      revision: 1,
      definition: office,
      skills,
    });
    const renamed = buildEmployeeRuntimePackage({
      revision: 2,
      definition: { ...office, name: '文档小助理' },
      skills,
    });
    expect(first.files.identityMd).toContain('- 名称：Office 文档助手');
    expect(first.files.identityMd).toContain('- 身份：文档助手');
    expect(first.files.identityMd).toContain(office.identity.mission);
    expect(first.files.identityMd).not.toContain('Rice');
    expect(renamed.files.identityMd).toContain('- 名称：文档小助理');
    expect(renamed.files.identityMd).not.toContain('Office 文档助手');
    expect(renamed.checksum).not.toBe(first.checksum);
    expect(first.files.identityMd).toContain('- 名称：Office 文档助手');
  });
  it('keeps v1 resource-free package identities readable after JSONB reordering', () => {
    const pkg = buildEmployeeRuntimePackage({
      revision: 7,
      definition,
      skills,
    });
    expect(pkg.schemaVersion).toBe(1);
    const bytes = JSON.stringify(pkg);
    expect(frozenPackageSkills(jsonbLikeRoundTrip(pkg))).toEqual(pkg.skills);
    expect(JSON.stringify(pkg)).toBe(bytes);
    expect(pkg.skills.every((skill) => !Object.hasOwn(skill, 'bundle'))).toBe(
      true,
    );
  });
  it('migrates active previews to frozen snapshots and per-run deadlines', () => {
    expect(previewSnapshotMigration).toContain(
      'add column frozen_runtime_profile jsonb',
    );
    expect(previewSnapshotMigration).toContain(
      'add column frozen_definition jsonb',
    );
    expect(previewSnapshotMigration).toContain(
      'add column frozen_native_skills jsonb',
    );
    expect(previewSnapshotMigration).toContain(
      'add column frozen_package_checksum text',
    );
    expect(previewSnapshotMigration).toContain(
      'add column timeout_at timestamptz',
    );
    expect(previewSnapshotMigration).toContain(
      "frozen_runtime_profile ->> 'timeoutMs'",
    );
    expect(previewSnapshotMigration).toContain(
      'allrice_platform_employee_test_snapshot_active_check',
    );
    expect(previewSnapshotMigration).toContain(
      "'executionSnapshot':'frozen'".replaceAll("'", '"'),
    );
    expect(previewSnapshotMigration).not.toContain("interval '15 minutes'");
  });

  it('treats repeated terminal completion as an idempotent replay', () => {
    expect(platformEmployeeTestCanFinalize('running')).toBe(true);
    expect(platformEmployeeTestCanFinalize('succeeded')).toBe(false);
    expect(platformEmployeeTestCanFinalize('failed')).toBe(false);
  });

  it('derives the preview deadline from the frozen timeout plus grace', () => {
    const startedAt = new Date('2026-09-01T00:00:00.000Z');
    expect(platformEmployeeTestTimeoutAt(startedAt, 3_600_000)).toEqual(
      new Date('2026-09-01T01:01:00.000Z'),
    );
    expect(
      platformEmployeeTestTimeoutAt(startedAt, 3_600_000).getTime(),
    ).toBeGreaterThan(startedAt.getTime() + 15 * 60_000);
  });

  it('accepts an intact frozen preview snapshot and fails closed on drift', () => {
    const snapshot = validFrozenExecutionSnapshot();
    expect(
      validatePlatformEmployeeTestExecutionSnapshot(snapshot),
    ).toMatchObject({
      runtimeProfile: { employeeKey: 'rice', model: 'gpt-5.6-luna' },
      nativeSkills: [{ name: 'web-research' }],
    });
    expect(
      validatePlatformEmployeeTestExecutionSnapshot(
        jsonbLikeRoundTrip(snapshot) as typeof snapshot,
      ),
    ).toMatchObject({
      runtimeProfile: { employeeKey: 'rice' },
      nativeSkills: [{ name: 'web-research' }],
    });

    expect(() =>
      validatePlatformEmployeeTestExecutionSnapshot({
        ...snapshot,
        nativeSkills: [
          { ...snapshot.nativeSkills[0]!, content: '# Tampered Skill' },
        ],
      }),
    ).toThrow('platform_employee_test_skill_checksum_mismatch');
    expect(() =>
      validatePlatformEmployeeTestExecutionSnapshot({
        ...snapshot,
        nativeSkills: [],
      }),
    ).toThrow('platform_employee_test_skill_snapshot_count_mismatch');
    expect(() =>
      validatePlatformEmployeeTestExecutionSnapshot({
        ...snapshot,
        packageChecksum: `sha256:${'0'.repeat(64)}`,
      }),
    ).toThrow('platform_employee_test_package_checksum_mismatch');
    expect(() =>
      validatePlatformEmployeeTestExecutionSnapshot({
        ...snapshot,
        runtimeProfile: {
          ...snapshot.runtimeProfile,
          nativeSkillIds: [
            snapshot.runtimeProfile.nativeSkillIds[0]!,
            snapshot.runtimeProfile.nativeSkillIds[0]!,
          ],
          nativeSkillChecksums: [
            snapshot.runtimeProfile.nativeSkillChecksums[0]!,
            snapshot.runtimeProfile.nativeSkillChecksums[0]!,
          ],
        },
        nativeSkills: [
          snapshot.nativeSkills[0]!,
          { ...snapshot.nativeSkills[0]!, id: randomUUID() },
        ],
      }),
    ).toThrow('platform_employee_test_skill_snapshot_count_mismatch');
  });

  it('lets preview cancellation win the terminal lifecycle race', () => {
    expect(
      platformEmployeeTestExecutionTerminalState({
        hasError: false,
        cancelRequested: true,
        runState: 'running',
      }),
    ).toMatchObject({
      testStatus: 'failed',
      jobStatus: 'canceled',
      runStatus: 'canceled',
      eventType: 'run.canceled',
      errorCode: 'TEST_CANCELED',
    });
  });

  it('maps successful and failed previews to matching Run and Job states', () => {
    expect(
      platformEmployeeTestExecutionTerminalState({
        hasError: false,
        cancelRequested: false,
        runState: 'running',
      }),
    ).toMatchObject({
      testStatus: 'succeeded',
      jobStatus: 'succeeded',
      runStatus: 'succeeded',
    });
    expect(
      platformEmployeeTestExecutionTerminalState({
        hasError: true,
        cancelRequested: false,
        runState: 'running',
      }),
    ).toMatchObject({
      testStatus: 'failed',
      jobStatus: 'failed',
      runStatus: 'failed',
    });
  });

  it('builds one deterministic source package for platform and tenant runtimes', () => {
    const first = buildEmployeeRuntimePackage({
      revision: 7,
      definition,
      skills,
    });
    const second = buildEmployeeRuntimePackage({
      revision: 7,
      definition,
      skills: [...skills].reverse(),
    });

    expect(second).toEqual(first);
    expect(first.packageVersion).toBe('rice:r7');
    expect(first.runtimeManifest).toMatchObject({
      source: 'allrice-published-runtime',
      harness: 'dsh',
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      toolNames: ['web.search'],
    });
    expect(first.files.agentsMd).toContain('自主选择最匹配的 Skill');
    expect(first.files.agentsMd).toContain('web-research');
    expect(first.files.agentsMd).toContain('自主路由规则');
    expect(first.files.agentsMd).toContain(
      '有网页链接直接 web_fetch，没有来源再 web_search',
    );
    expect(first.files.agentsMd).toContain('用户不需要点名 Skill');
    expect(first.files.identityMd).toContain('通用工作伙伴');
    expect(first.files.soulMd).toContain('不编造执行结果');
    expect(first.files.soulMd).toContain('本次运行注入的成员设置为准');
    expect(first.files.soulMd).not.toContain('操作确认策略：');
    expect(first.files.userMd).toContain('动态注入');
    expect(first.skills[0]?.content).toContain('交叉核验');
    expect(first.runtimeManifest.skillGovernance[0]).toMatchObject({
      name: 'web-research',
      version: '1.0.0',
      license: 'Apache-2.0',
      reviewStatus: 'reviewed',
    });
  });

  it('changes the immutable package when a published Skill changes', () => {
    const before = buildEmployeeRuntimePackage({
      revision: 7,
      definition,
      skills,
    });
    const after = buildEmployeeRuntimePackage({
      revision: 8,
      definition,
      skills: [
        {
          ...skills[0]!,
          content: '# Web Research\n\n更新后的生产说明。',
          checksum: `sha256:${createHash('sha256').update('# Web Research\n\n更新后的生产说明。').digest('hex')}`,
        },
      ],
    });

    expect(after.checksum).not.toBe(before.checksum);
    expect(after.capabilityFingerprint).not.toBe(before.capabilityFingerprint);
  });

  it('projects the same package and prompt into the tenant employee manifest', () => {
    const runtimePackage = buildEmployeeRuntimePackage({
      revision: 7,
      definition,
      skills,
    });
    const systemPrompt = runtimePackageSystemPrompt({
      platformPolicy: definition.systemPrompt,
      runtimePackage,
    });
    const manifest = employeeManifest({
      key: 'default-assistant',
      name: definition.name,
      description: definition.description,
      identity: {
        role: definition.identity.role,
        mission: definition.identity.mission,
        workStyle: definition.identity.workStyle,
        behaviorRules: definition.identity.behaviorRules,
        safetyBoundaries: definition.identity.safetyBoundaries,
      },
      runtimePolicy: {
        harness: 'dsh',
        provider: definition.modelPolicy.provider,
        model: definition.modelPolicy.model,
        reasoningEffort: definition.modelPolicy.reasoningEffort,
        timeoutMs: definition.modelPolicy.timeoutMs,
        fallbackModels: definition.modelPolicy.fallbackModels,
        credentialReference: definition.modelPolicy.credentialReference,
        baseUrl: definition.modelPolicy.baseUrl,
      },
      securityPolicy: {
        dataScopes: definition.securityPolicy.dataScopes,
        connectorIdentityModes:
          definition.securityPolicy.connectorIdentityModes,
        approvalPolicy: definition.securityPolicy.approvalPolicy,
        deniedCapabilities: definition.securityPolicy.deniedCapabilities,
      },
      toolNames: definition.capabilities.toolNames,
      systemPromptOverride: systemPrompt,
      runtimePackage,
    });

    expect(manifest.schemaVersion).toBe(2);
    if (manifest.schemaVersion === 2) {
      expect(manifest.systemPrompt).toBe(systemPrompt);
      expect(manifest.runtimePackage?.checksum).toBe(runtimePackage.checksum);
      expect(manifest.runtimePackage).toEqual(runtimePackage);
    }
  });
});
