import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import {
  SkillArtifactBundleSchema,
  type SkillArtifactBundle,
  type StorageObject,
} from '@allrice/contracts';
import { LocalStorageAdapter } from '@allrice/storage';

import { HandlerError } from './errors.js';

const maximumArtifactBytes = 2_000_000;

export async function readSkillArtifact(
  storageRoot: string,
  object: StorageObject,
): Promise<SkillArtifactBundle> {
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = await new LocalStorageAdapter(storageRoot).get(object);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HandlerError(
        'SKILL_ARTIFACT_MISSING',
        'Skill artifact is missing from local storage',
        false,
      );
    }
    throw error;
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumArtifactBytes) {
        throw new HandlerError(
          'SKILL_ARTIFACT_TOO_LARGE',
          'Skill artifact exceeds the runtime limit',
          false,
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const content = Buffer.concat(chunks);
  const checksum = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  if (content.byteLength !== object.sizeBytes || checksum !== object.checksum) {
    throw new HandlerError(
      'SKILL_ARTIFACT_MISMATCH',
      'Skill artifact failed integrity validation',
      false,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString('utf8'));
  } catch {
    throw new HandlerError(
      'SKILL_ARTIFACT_INVALID',
      'Skill artifact is not valid JSON',
      false,
    );
  }
  return SkillArtifactBundleSchema.parse(parsed);
}

export async function materializeSkillBundle(
  bundle: SkillArtifactBundle,
  workDirectory: string,
) {
  const root = resolve(workDirectory, 'skill-artifact');
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const file of bundle.files) {
    const path = resolve(root, file.path);
    if (!path.startsWith(`${root}${sep}`)) {
      throw new HandlerError(
        'SKILL_PATH_INVALID',
        'Skill artifact path escaped the execution directory',
        false,
      );
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, file.content, { encoding: 'utf8', mode: 0o600 });
  }
}

export async function skillInstructionsForStorageObjects(
  storageRoot: string,
  objects: readonly StorageObject[],
) {
  return Promise.all(
    objects.map(async (object) => {
      const bundle = await readSkillArtifact(storageRoot, object);
      return bundle.files.find((file) => file.path === bundle.entrypoint)!
        .content;
    }),
  );
}
