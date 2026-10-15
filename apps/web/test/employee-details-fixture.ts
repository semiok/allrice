import {
  EmployeeDetailsSchema,
  type EmployeeResolvedContent,
} from '@allrice/contracts';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = `sha256:${'a'.repeat(64)}`;
export function employeeDetailsFixture() {
  const source = (
    n: number,
    title: string,
    scope: 'personal' | 'department' | 'company',
    kind: EmployeeResolvedContent['reference']['sourceKind'] = 'requirement',
  ): EmployeeResolvedContent => ({
    reference: {
      sourceKind: kind,
      contentId: id(n),
      revisionId: id(n + 100),
      digest,
    },
    available: true,
    title,
    body: `${title}正文`,
    canMaintain: true,
    ownership:
      scope === 'personal'
        ? { scope, organizationId: id(3), ownerId: id(5) }
        : scope === 'department'
          ? { scope, organizationId: id(3), departmentId: id(60) }
          : { scope, organizationId: id(3) },
  });
  const common = [
    source(30, '公司核对标准', 'company'),
    source(31, '部门指标口径', 'department'),
    source(32, '个人输出偏好', 'personal'),
  ];
  const weekly = source(33, '每周核对', 'personal');
  const monthly = source(34, '月度审计', 'department');
  const file = source(35, '核对样例.md', 'personal', 'knowledge');
  file.referenceFile = {
    sourceId: id(35),
    revisionId: id(135),
    revision: 1,
    digest,
    checksum: digest,
    fileName: '核对样例.md',
    purpose: '原始参考样例',
    ownership: file.ownership!,
  };
  const procedure = source(36, '对账流程', 'company', 'procedure');
  const unavailable = {
    ...source(37, '撤权后不应看到的标题', 'personal'),
    available: false,
    ownership: null,
    canMaintain: false,
  };
  return EmployeeDetailsSchema.parse({
    profile: {
      instanceId: id(7),
      kind: 'general',
      revision: 2,
      source: {
        kind: 'platform',
        employeeVersionId: id(8),
        templateId: id(70),
        templateRevisionId: id(71),
        templateRevision: 1,
        templateChecksum: digest,
      },
      name: 'Rice',
      description: '负责研究、分析与文件交付',
      appearance: {
        avatarType: 'initials',
        avatarValue: 'R',
        accentColor: 'violet',
      },
      identity: {
        role: '研究助理',
        mission: '帮助完成研究',
        workStyle: '按步骤交付',
        behaviorRules: ['不得编造'],
        safetyBoundaries: [],
      },
      expressionStyle: 'concise',
      personalFields: ['expressionStyle'],
      canMaintainPersonal: true,
    },
    content: {
      instanceId: id(7),
      employeeId: id(9),
      platform: { revisionId: id(71), digest, requirements: ['不得编造'] },
      common: [...common, file, procedure, unavailable].map((s) => s.reference),
      scenes: [
        {
          id: id(50),
          name: '每周对账',
          appliesWhen: '每周收到流水后',
          references: [weekly.reference],
        },
        {
          id: id(51),
          name: '每月审计',
          appliesWhen: '每月结算后',
          references: [monthly.reference],
        },
      ],
      sources: [...common, weekly, monthly, file, procedure, unavailable],
      layers: [
        {
          id: id(80),
          workspaceId: id(4),
          ownership: common[2]!.ownership,
          target: { kind: 'instance', instanceId: id(7) },
          revision: 1,
          active: null,
          candidate: {
            id: id(81),
            number: 1,
            digest,
            manifest: {
              schemaVersion: 1,
              common: [],
              scenes: [
                {
                  id: id(82),
                  name: '未启用草稿不能显示',
                  appliesWhen: '草稿',
                  references: [],
                },
              ],
              declaredConflicts: [],
            },
            changeSummary: '未启用',
            createdAt: '2026-10-15T00:00:00.000Z',
          },
          validation: null,
          access: {
            canRead: true,
            canMaintain: true,
            readReason: 'allowed',
            maintenanceReason: 'allowed',
          },
        },
      ],
      validation: {
        valid: false,
        issues: [
          { code: 'source_unavailable', message: 'Private source revoked' },
        ],
        dependencyDigest: digest,
        semanticConsistency: 'not_proven',
      },
    },
  });
}
