import { posix } from 'node:path';
import { LocalStorageAdapter } from '@allrice/storage';
import { personalSkillLimits, type StorageObject } from '@allrice/contracts';
import {
  PersonalSkillError,
  resolvePersonalSkillResource,
  skillBytesChecksum,
} from '@allrice/database';
import { readFileArchive } from '@allrice/file-archives';

export async function readPersonalSkillBytes(
  root: string,
  object: StorageObject,
  maximum: number,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (object.sizeBytes > maximum)
    throw new PersonalSkillError('source_invalid');
  const reader = (await new LocalStorageAdapter(root).get(object)).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) throw new PersonalSkillError('source_invalid');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  if (
    bytes.length !== object.sizeBytes ||
    skillBytesChecksum(bytes) !== object.checksum
  )
    throw new PersonalSkillError('source_invalid');
  return bytes;
}

/** One shared resolver for resource reads and the existing isolated runners. */
export async function readPrivateSkillResource(
  input: Parameters<typeof resolvePersonalSkillResource>[0] & {
    storageRoot: string;
    signal?: AbortSignal;
  },
) {
  const selected = await resolvePersonalSkillResource(input);
  const archive = await readPersonalSkillBytes(
    input.storageRoot,
    selected.object,
    personalSkillLimits.archiveBytes,
    input.signal,
  );
  const files = await readFileArchive(archive, { signal: input.signal });
  const path = posix.join(
    posix.dirname(selected.sourcePath),
    selected.resource.path,
  );
  const file = files.find((file) => file.path === path);
  if (
    !file ||
    file.bytes.byteLength !== selected.resource.byteLength ||
    skillBytesChecksum(file.bytes) !== selected.resource.checksum
  )
    throw new PersonalSkillError('source_invalid');
  input.signal?.throwIfAborted();
  // Revocation during IO must take effect before this response exposes bytes.
  const current = await resolvePersonalSkillResource(input);
  if (JSON.stringify(current) !== JSON.stringify(selected))
    throw new PersonalSkillError('conflict');
  return {
    skill: selected.skill,
    version: selected.version,
    versionId: selected.versionId,
    packageChecksum: selected.packageChecksum,
    source: 'personal' as const,
    ...selected.resource,
    contentBase64: Buffer.from(file.bytes).toString('base64'),
  };
}
