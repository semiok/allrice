import {
  PersonalSkillPreviewRequestSchema,
  PersonalSkillPreviewResponseSchema,
  UuidSchema,
  personalSkillLimits,
  type RequestContext,
} from '@allrice/contracts';
import {
  DataAccessError,
  getEmployeeInstance,
  previewPersonalSkillUpdateTarget,
  previewPersonalSkillInstallTarget,
  PersonalSkillError,
  skillBytesChecksum,
} from '@allrice/database';
import { createFileArchive, readFileArchive } from '@allrice/file-archives';
import {
  inspectPersonalSkillPackage,
  readPublicGitHubSource,
  SkillPreviewError,
  SkillPreviewTokens,
} from '@allrice/skill-import';

/** Same lifetime as existing signed file reads. A preview has no installation
 * or permission state; exact bytes are attested in the returned payload. */
export const skillPreviewLifetimeSeconds = 300;

export function getSkillPreviewTokens() {
  const secret =
    process.env.ALLRICE_STORAGE_SIGNING_SECRET ??
    (process.env.NODE_ENV === 'production'
      ? undefined
      : 'allrice-development-signing-secret-change-me');
  if (!secret)
    throw new Error('ALLRICE_STORAGE_SIGNING_SECRET is required in production');
  return new SkillPreviewTokens(secret);
}

export async function previewPersonalSkillSource(
  originalContext: RequestContext,
  instanceIdInput: string,
  raw: unknown,
  archive?: Uint8Array,
  signal?: AbortSignal,
) {
  const input = PersonalSkillPreviewRequestSchema.parse(raw);
  const instanceId = UuidSchema.parse(instanceIdInput);
  if (!originalContext.sessionId || originalContext.actor.type !== 'user')
    throw new DataAccessError('authorization_denied');
  const context = { ...originalContext, workspaceId: input.workspaceId };
  const target = input.target;
  const authorize = async () => {
    await getEmployeeInstance(context, instanceId);
    if (target.operation === 'install') return null;
    try {
      return await previewPersonalSkillUpdateTarget(
        context,
        instanceId,
        target,
      );
    } catch (error) {
      if (error instanceof PersonalSkillError && error.code === 'conflict')
        throw new SkillPreviewError('version_conflict');
      throw error;
    }
  };
  await authorize();
  signal?.throwIfAborted();

  let bytes: Uint8Array;
  let files;
  let github;
  if (input.source.kind === 'github') {
    if (archive !== undefined) throw new SkillPreviewError('source_invalid');
    github = await readPublicGitHubSource(input.source.url, {
      signal,
      rootOnly: true,
    });
    files = github.files;
    bytes = await createFileArchive(files, { signal });
  } else {
    if (!archive || archive.byteLength > personalSkillLimits.archiveBytes)
      throw new SkillPreviewError('source_invalid');
    bytes = Buffer.from(archive);
    // Same bounded ZIP read deadline as the existing personal Skill reader.
    const timeout = AbortSignal.timeout(15_000);
    files = await readFileArchive(bytes, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  }
  if (bytes.byteLength > personalSkillLimits.archiveBytes)
    throw new SkillPreviewError('source_invalid');
  const candidates = await inspectPersonalSkillPackage(files, signal, [
    'SKILL.md',
  ]);
  const candidate = candidates[0]!;
  if (!candidate.parsed || candidate.issues.length)
    throw new SkillPreviewError('source_invalid');
  const definition = candidate.parsed.definition;
  const current = await authorize();
  if (current && current.name !== definition.name)
    throw new SkillPreviewError('name_mismatch');
  signal?.throwIfAborted();

  const digest = skillBytesChecksum(bytes);
  const expiresAt = new Date(
    Date.now() + skillPreviewLifetimeSeconds * 1000,
  ).toISOString();
  const source = github
    ? {
        kind: 'github' as const,
        ...github.provenance,
        fileName: `${github.provenance.repository}.zip`,
        originalChecksum: digest,
        byteLength: bytes.byteLength,
        candidatePath: 'SKILL.md',
      }
    : {
        kind: 'zip' as const,
        fileName: input.source.kind === 'zip' ? input.source.fileName : '',
        originalChecksum: digest,
        byteLength: bytes.byteLength,
      };
  const tokens = getSkillPreviewTokens();
  const attestedTarget =
    target.operation === 'update'
      ? { ...target, bindingsDigest: current!.bindingsDigest }
      : {
          ...target,
          expectedInstallation: await previewPersonalSkillInstallTarget(
            context,
            instanceId,
            definition.name,
          ),
        };
  const previewId = tokens.issue(
    {
      schemaVersion: 1,
      organizationId: context.organizationId,
      workspaceId: input.workspaceId,
      ownerId: context.actor.id,
      instanceId,
      source,
      sourcePath: 'SKILL.md',
      target: attestedTarget,
      expiresAt,
      digest,
    },
    bytes,
  );
  return PersonalSkillPreviewResponseSchema.parse({
    instanceId,
    operation: target.operation,
    previewId,
    digest,
    expiresAt,
    target: attestedTarget,
    ...(current ? { affectedBindings: current.bindings } : {}),
    item: {
      name: definition.name,
      description: definition.description,
      ...(typeof definition.metadata?.displayName === 'string'
        ? { displayName: definition.metadata.displayName }
        : {}),
      ...(typeof definition.metadata?.version === 'string'
        ? { version: definition.metadata.version }
        : {}),
      ...(definition.whenToUse ? { whenToUse: definition.whenToUse } : {}),
      invocation: definition.invocation,
    },
    source,
    files: [
      {
        path: 'SKILL.md',
        byteLength: Buffer.byteLength(candidate.parsed.originalText),
        checksum: skillBytesChecksum(candidate.parsed.originalText),
      },
      ...candidate.resources.map(({ path, byteLength, checksum }) => ({
        path,
        byteLength,
        checksum,
      })),
    ],
    effectiveFrom: 'next_task' as const,
    installed: false as const,
    scriptsExecuted: false as const,
  });
}
