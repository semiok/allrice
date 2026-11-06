import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ChecksumSchema,
  UuidSchema,
  localFileMediaType,
  type RequestContext,
} from '@allrice/contracts';
import {
  authorizePersonalSkillBrowser,
  confirmPersonalSkillBrowser,
  preparePersonalSkillBrowserConfirmation,
  abandonPersonalSkillBrowserArchive,
  createStorageMetadata,
  runtimePolicyDigest,
  skillBytesChecksum,
} from '@allrice/database';
import { readFileArchive } from '@allrice/file-archives';
import {
  inspectPersonalSkillPackage,
  SkillPreviewError,
} from '@allrice/skill-import';
import { getStorageAdapter } from '../storage/runtime';
import { getSkillPreviewTokens } from './personal-skill-preview';

const schema = z
  .object({
    workspaceId: UuidSchema,
    requestId: UuidSchema,
    previewId: z.string().min(1),
    digest: ChecksumSchema,
  })
  .strict();

export async function confirmPersonalSkillSource(
  originalContext: RequestContext,
  instanceIdInput: string,
  raw: unknown,
  signal?: AbortSignal,
) {
  const input = schema.parse(raw),
    instanceId = UuidSchema.parse(instanceIdInput);
  const context = { ...originalContext, workspaceId: input.workspaceId };
  await authorizePersonalSkillBrowser(context, instanceId);
  const { preview, bytes } = getSkillPreviewTokens().verify(input.previewId, {
    organizationId: context.organizationId,
    workspaceId: input.workspaceId,
    ownerId: context.actor.id,
    instanceId,
    digest: input.digest,
  });
  const deadline = AbortSignal.timeout(15_000);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const [candidate] = await inspectPersonalSkillPackage(
    await readFileArchive(bytes, { signal: bounded }),
    bounded,
    ['SKILL.md'],
  );
  if (!candidate?.parsed || candidate.issues.length)
    throw new SkillPreviewError('source_invalid');
  await authorizePersonalSkillBrowser(context, instanceId);
  bounded.throwIfAborted();
  const objectId = randomUUID();
  const payload = {
    schemaVersion: 1 as const,
    archiveObjectId: objectId,
    sourcePath: 'SKILL.md',
    resources: candidate.resources.map(({ path, checksum, byteLength }) => ({
      path,
      checksum,
      byteLength,
      mediaType: localFileMediaType(path),
    })),
  };
  const confirmation = {
    instanceId,
    requestId: input.requestId,
    attestationDigest: skillBytesChecksum(input.previewId),
    target: preview.target,
    source:
      preview.source.kind === 'github'
        ? preview.source
        : {
            ...preview.source,
            kind: 'attachment',
            objectId,
            candidatePath: 'SKILL.md',
          },
    originalText: candidate.parsed.originalText,
    definition: candidate.parsed.definition,
    resourceManifest: { ...payload, checksum: runtimePolicyDigest(payload) },
  };
  const completed = await preparePersonalSkillBrowserConfirmation(
    context,
    confirmation,
  );
  if (completed) return completed;
  const storage = getStorageAdapter();
  let pending: Awaited<ReturnType<typeof createStorageMetadata>> | undefined;
  try {
    pending = await createStorageMetadata(context, {
      id: objectId,
      workspaceId: input.workspaceId,
      category: 'memory',
      mediaType: 'application/zip',
      sizeBytes: bytes.length,
      checksum: input.digest,
      visibility: 'private',
      retentionUntil: null,
      immutable: false,
    });
    await storage.put(pending.object, new Blob([bytes]).stream());
    bounded.throwIfAborted();
    return await confirmPersonalSkillBrowser(context, confirmation);
  } finally {
    // Completed immutable objects are never claimed here. Pending duplicates,
    // rolled-back confirmations use existing cleanup. Metadata creation can
    // commit before its audit/response fails; claim that pending row too, but
    // no bytes could have been written without receiving its descriptor.
    // If the DB cannot establish the state, leave the bytes intact and fail.
    if (
      (await abandonPersonalSkillBrowserArchive(context, objectId)) &&
      pending
    )
      await storage.delete(pending.object);
  }
}
