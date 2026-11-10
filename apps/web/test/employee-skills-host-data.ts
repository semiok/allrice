/** Synthetic HTTP records for the isolated host fixture, not production data. */
import {
  ApiErrorSchema,
  EmployeeSkillCatalogSchema,
  PersonalSkillConfirmResponseSchema,
  PersonalSkillPreviewResponseSchema,
  PersonalSkillRemoveResponseSchema,
  type PersonalSkillPreviewRequest,
  type PersonalSkillPreviewResponse,
  type PersonalSkillConfirmResponse,
} from '@allrice/contracts';

export const skillTestId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const skillTestChecksum = (letter = 'a') =>
  `sha256:${letter.repeat(64)}`;
export const skillTestScope = {
  scopeId: 'owner-synthetic',
  workspaceId: skillTestId(4),
  instanceId: skillTestId(7),
  headers: { 'X-Synthetic-Viewer': 'owner' },
};

export function skillTestCatalog(
  instanceId = skillTestId(7),
  workspaceId = skillTestId(4),
) {
  return EmployeeSkillCatalogSchema.parse({
    instanceId,
    canInstall: true,
    platformSkills: [
      {
        kind: 'platform',
        id: 'market-data',
        name: 'market-data',
        displayName: '行情数据',
        description:
          '查询股票、指数、ETF、汇率、加密货币和商品的结构化公开行情与历史走势，明确数据时间、币种、来源和延迟限制。',
        version: '1.0.1',
        checksum: skillTestChecksum(),
        canUninstall: false,
      },
    ],
    personalSkills: [
      {
        kind: 'personal',
        name: 'translation-review',
        displayName: '翻译校对',
        description: '按术语表校对中英文稿件',
        version: 'v0.3.0',
        installationVersion: 9,
        installationId: skillTestId(200),
        versionId: skillTestId(201),
        revision: 4,
        binding: {
          id:
            instanceId === skillTestId(7) ? skillTestId(202) : skillTestId(212),
          instanceId,
          workspaceId,
          enabled: true,
          epoch: 2,
          label: instanceId === skillTestId(7) ? 'Rice' : '流程哥',
        },
        source: {
          kind: 'attachment',
          objectId: skillTestId(203),
          fileName: 'translation-review.zip',
          originalChecksum: skillTestChecksum(),
          byteLength: 5,
          candidatePath: 'SKILL.md',
        },
        canUninstall: true,
        definitionChecksum: skillTestChecksum('d'),
        packageChecksum: skillTestChecksum('e'),
        resourceCount: 1,
      },
    ],
  });
}

export function skillTestPreview({
  instanceId = skillTestId(7),
  workspaceId = skillTestId(4),
  operation = 'update',
  source = {
    kind: 'github',
    url: 'https://github.com/example/translation-review',
  },
  target,
  single = false,
}: {
  instanceId?: string;
  workspaceId?: string;
  operation?: 'install' | 'update';
  source?:
    | { kind: 'github'; url: string }
    | { kind: 'zip'; fileName: string; byteLength: number };
  target?: PersonalSkillPreviewRequest['target'];
  single?: boolean;
} = {}) {
  const catalog = skillTestCatalog(instanceId, workspaceId),
    current = catalog.personalSkills[0];
  if (!current) throw new Error('Synthetic current binding missing');
  const affectedBindings = [
    { ...current.binding, workspaceLabel: '工作区一' },
    ...(single
      ? []
      : [
          {
            id: skillTestId(204),
            instanceId:
              instanceId === skillTestId(7) ? skillTestId(8) : skillTestId(7),
            workspaceId,
            enabled: false,
            epoch: 3,
            label: instanceId === skillTestId(7) ? '流程哥' : 'Rice',
            workspaceLabel: '工作区一',
          },
          {
            id: skillTestId(205),
            instanceId: skillTestId(9),
            workspaceId: skillTestId(5),
            enabled: true,
            epoch: 1,
            label: '流程哥',
            workspaceLabel: '工作区二',
          },
        ]),
  ];
  const requestTarget =
    target ??
    (operation === 'install'
      ? { operation: 'install' as const }
      : {
          operation: 'update' as const,
          installationId: current.installationId,
          expectedRevision: current.revision,
          expectedVersionId: current.versionId,
        });
  const metadata =
    source.kind === 'github'
      ? {
          kind: 'github',
          requestedUrl: source.url,
          owner: 'example',
          repository: 'translation-review',
          resolvedRef: 'main',
          commitSha: 'b'.repeat(40),
          treeSha: 'c'.repeat(40),
          sourcePath: '',
          fileName: 'translation-review.zip',
          originalChecksum: skillTestChecksum('b'),
          byteLength: 5,
          candidatePath: 'SKILL.md',
          license: { status: 'unknown' },
        }
      : {
          kind: 'zip',
          fileName: source.fileName,
          byteLength: source.byteLength,
          originalChecksum: skillTestChecksum('b'),
        };
  return PersonalSkillPreviewResponseSchema.parse({
    instanceId,
    operation: requestTarget.operation,
    previewId: 'synthetic-signed-preview-not-a-real-token',
    digest: metadata.originalChecksum,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    target:
      requestTarget.operation === 'install'
        ? { ...requestTarget, expectedInstallation: null }
        : { ...requestTarget, bindingsDigest: skillTestChecksum('c') },
    ...(requestTarget.operation === 'update' ? { affectedBindings } : {}),
    item: {
      name: 'translation-review',
      displayName: '翻译校对',
      description: '按术语表校对中英文稿件',
      invocation: { modelInvocable: true, userInvocable: true },
      version: 'release-candidate',
    },
    source: metadata,
    files: [
      { path: 'SKILL.md', byteLength: 50, checksum: skillTestChecksum('f') },
      { path: 'terms.csv', byteLength: 10, checksum: skillTestChecksum('e') },
    ],
    effectiveFrom: 'next_task',
    installed: false,
    scriptsExecuted: false,
  });
}

export function skillTestConfirmed(
  preview: PersonalSkillPreviewResponse,
  requestId: string,
  unchanged = false,
) {
  const current = skillTestCatalog(preview.instanceId).personalSkills[0];
  if (!current) throw new Error('Synthetic current binding missing');
  const update = preview.operation === 'update';
  const revision = update
    ? unchanged
      ? current.revision
      : current.revision + 1
    : 1;
  const versionId = update && unchanged ? current.versionId : skillTestId(211);
  const source =
    update && unchanged
      ? current.source
      : preview.source.kind === 'github'
        ? preview.source
        : {
            kind: 'attachment' as const,
            objectId: skillTestId(210),
            fileName: preview.source.fileName,
            originalChecksum: preview.source.originalChecksum,
            byteLength: preview.source.byteLength,
            candidatePath: 'SKILL.md',
          };
  const skill = {
    id: current.installationId,
    name: preview.item.name,
    description: preview.item.description,
    revision,
    state: 'installed',
    versionId,
    version: update
      ? unchanged
        ? current.installationVersion
        : current.installationVersion + 1
      : 1,
    source,
    definitionChecksum:
      update && unchanged ? current.definitionChecksum : skillTestChecksum('f'),
    packageChecksum:
      update && unchanged ? current.packageChecksum : skillTestChecksum('e'),
    resourceCount: 1,
    compatibility: 'instruction_format_checked',
    businessVerification: 'not_verified',
    bindings: preview.affectedBindings
      ? preview.affectedBindings.map((binding) => ({
          id: binding.id,
          instanceId: binding.instanceId,
          workspaceId: binding.workspaceId,
          enabled: binding.enabled,
          epoch: binding.epoch,
          label: binding.label,
        }))
      : [current.binding],
    createdAt: '2026-11-05T10:00:00.000Z',
    updatedAt: '2026-11-05T10:01:00.000Z',
  };
  return PersonalSkillConfirmResponseSchema.parse({
    skill,
    ...(preview.affectedBindings
      ? { affectedBindings: preview.affectedBindings }
      : {}),
    receipt: {
      operation: preview.operation,
      requestId,
      instanceId: preview.instanceId,
      installationId: skill.id,
      revision,
      versionId,
      definitionChecksum: skill.definitionChecksum,
      packageChecksum: skill.packageChecksum,
      source,
      effectiveFrom: 'next_task',
      ...(preview.affectedBindings
        ? { affectedBindings: preview.affectedBindings, unchanged }
        : {}),
    },
  });
}

export function skillTestCatalogAfter(
  result: PersonalSkillConfirmResponse,
  authorVersion: string | null = 'release-candidate',
  authorName: string | null = '翻译校对',
) {
  const catalog = skillTestCatalog(result.receipt.instanceId),
    binding = result.skill.bindings.find(
      (item) => item.instanceId === result.receipt.instanceId,
    );
  if (!binding) throw new Error('Synthetic receipt binding missing');
  return EmployeeSkillCatalogSchema.parse({
    ...catalog,
    personalSkills: [
      {
        ...catalog.personalSkills[0],
        version: authorVersion?.trim() ? authorVersion : null,
        displayName: authorName?.trim() ? authorName : result.skill.name,
        installationVersion: result.skill.version,
        installationId: result.skill.id,
        versionId: result.skill.versionId,
        revision: result.skill.revision,
        source: result.skill.source,
        definitionChecksum: result.skill.definitionChecksum,
        packageChecksum: result.skill.packageChecksum,
        binding,
      },
    ],
  });
}

export function skillTestRemoved(
  requestId: string,
  instanceId = skillTestId(7),
) {
  const current = skillTestCatalog(instanceId).personalSkills[0];
  if (!current) throw new Error('Synthetic removal binding missing');
  return PersonalSkillRemoveResponseSchema.parse({
    receipt: {
      operation: 'disable',
      scope: 'instance',
      requestId,
      workspaceId: current.binding.workspaceId,
      instanceId,
      installationId: current.installationId,
      revision: current.revision + 1,
      versionId: current.versionId,
      binding: {
        ...current.binding,
        enabled: false,
        epoch: current.binding.epoch + 1,
      },
    },
  });
}

export function skillTestProblem(
  code:
    | 'VERSION_CONFLICT'
    | 'AUTHORIZATION_DENIED'
    | 'RESOURCE_NOT_FOUND'
    | 'VALIDATION_FAILED' = 'VALIDATION_FAILED',
) {
  return ApiErrorSchema.parse({
    error: {
      code,
      message: 'synthetic diagnostic text never displayed by the host',
      requestId: skillTestId(999),
      retryable: false,
    },
  });
}
