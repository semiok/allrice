import { randomUUID } from 'node:crypto';
import {
  PersonalScenePreviewRequestSchema,
  PersonalScenePreviewResponseSchema,
  PersonalSceneConfirmRequestSchema,
  PersonalSceneConfirmResponseSchema,
  UuidSchema,
  personalSkillLimits,
  type RequestContext,
} from '@allrice/contracts';
import {
  getEmployeeInstance,
  canUsePersonalEmployeeScenes,
  DataAccessError,
  previewPersonalSceneFile,
  savePersonalSceneSkill,
  EmployeeContentError,
  skillBytesChecksum,
} from '@allrice/database';
import { readFileArchive } from '@allrice/file-archives';
import {
  inspectWorkflowSkillPackage,
  ScenePreviewTokens,
} from '@allrice/skill-import';
import {
  skillPreviewLifetimeSeconds,
  skillPreviewSigningSecret,
} from './personal-skill-preview';
import { readSkillPreviewSource } from './preview-source';

async function authorize(context: RequestContext, instanceId: string) {
  if (!context.sessionId || context.actor.type !== 'user')
    throw new DataAccessError('authorization_denied');
  const instance = await getEmployeeInstance(context, instanceId);
  if (!(await canUsePersonalEmployeeScenes(instance)))
    throw new DataAccessError('not_found');
}

export async function previewPersonalSceneSource(
  contextInput: RequestContext,
  instanceIdInput: string,
  raw: unknown,
  archive?: Uint8Array,
  signal?: AbortSignal,
) {
  const input = PersonalScenePreviewRequestSchema.parse(raw);
  const instanceId = UuidSchema.parse(instanceIdInput);
  const context = { ...contextInput, workspaceId: input.workspaceId };
  await authorize(context, instanceId);
  const { bytes, files, source } = await readSkillPreviewSource(
    input.source,
    archive,
    signal,
  );
  const sceneId =
    input.target.operation === 'install' ? randomUUID() : input.target.sceneId;
  const inspected = await inspectWorkflowSkillPackage(
    files,
    source,
    sceneId,
    signal,
  );
  const view = await previewPersonalSceneFile(context, instanceId, {
    workspaceId: input.workspaceId,
    file: inspected.file,
  });
  if (
    input.target.operation === 'update' &&
    (view.expectedRevision !== input.target.expectedRevision ||
      view.expectedContentRef !== input.target.expectedContentRef ||
      (view.current && view.current.nativeName !== inspected.frontmatter.name))
  )
    throw new EmployeeContentError('version_conflict');
  if (input.target.operation === 'install' && view.currentScene)
    throw new EmployeeContentError('version_conflict');
  await authorize(context, instanceId);
  signal?.throwIfAborted();
  const target = {
    operation: input.target.operation,
    sceneId,
    expectedRevision: view.expectedRevision,
    expectedContentRef: view.expectedContentRef,
  };
  const digest = skillBytesChecksum(bytes);
  const expiresAt = new Date(
    Date.now() + skillPreviewLifetimeSeconds * 1000,
  ).toISOString();
  const previewId = new ScenePreviewTokens(skillPreviewSigningSecret()).issue(
    {
      schemaVersion: 1,
      organizationId: context.organizationId,
      workspaceId: input.workspaceId,
      ownerId: context.actor.id,
      instanceId,
      source,
      sourcePath: 'SKILL.md',
      digest,
      target,
      expiresAt,
    },
    bytes,
  );
  return PersonalScenePreviewResponseSchema.parse({
    instanceId,
    instanceName: view.instanceName,
    operation: target.operation,
    previewId,
    digest,
    expiresAt,
    target,
    source,
    item: {
      frontmatter: inspected.frontmatter,
      content: inspected.content,
      stepsMarkdown: inspected.stepsMarkdown,
      deliverablesMarkdown: inspected.deliverablesMarkdown,
    },
    current: view.current,
    files: files.map((file) => ({
      path: file.path,
      byteLength: file.bytes.byteLength,
      checksum: skillBytesChecksum(file.bytes),
    })),
    effectiveFrom: 'next_load',
    installed: false,
    scriptsExecuted: false,
  });
}

export async function confirmPersonalSceneSource(
  contextInput: RequestContext,
  instanceIdInput: string,
  raw: unknown,
  signal?: AbortSignal,
) {
  const input = PersonalSceneConfirmRequestSchema.parse(raw);
  const instanceId = UuidSchema.parse(instanceIdInput);
  const context = { ...contextInput, workspaceId: input.workspaceId };
  await authorize(context, instanceId);
  const { preview, bytes } = new ScenePreviewTokens(
    skillPreviewSigningSecret(),
  ).verify(input.previewId, {
    organizationId: context.organizationId,
    workspaceId: input.workspaceId,
    ownerId: context.actor.id,
    instanceId,
    digest: input.digest,
  });
  const timeout = AbortSignal.timeout(15_000);
  const files = await readFileArchive(bytes, {
    maximumFiles: personalSkillLimits.packageResources + 1,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const { file } = await inspectWorkflowSkillPackage(
    files,
    preview.source,
    preview.target.sceneId,
    signal,
  );
  signal?.throwIfAborted();
  const result = await savePersonalSceneSkill(context, instanceId, {
    workspaceId: input.workspaceId,
    requestId: input.requestId,
    expectedRevision: preview.target.expectedRevision,
    expectedContentRef: preview.target.expectedContentRef,
    scene: {
      id: file.scene.id,
      name: file.scene.name,
      appliesWhen: file.scene.appliesWhen,
    },
    procedure: file.procedure,
    references: file.references,
    changeSummary:
      preview.target.operation === 'install'
        ? '本人确认导入工作场景'
        : '本人确认更新工作场景',
  });
  return PersonalSceneConfirmResponseSchema.parse({
    receipt: {
      ...result,
      operation: preview.target.operation,
      requestId: input.requestId,
      source: preview.source,
      effectiveFrom: 'next_load',
    },
  });
}
