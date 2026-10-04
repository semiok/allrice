import { createHash } from 'node:crypto';
import {
  RuntimeSavedProjectSourceSchema,
  runtimeContractEqual,
  projectSourceLimits,
} from '@allrice/contracts';
import { RuntimeCommandError as LocalCommandError } from './errors.js';
import type { ProjectRuntimeArguments } from './types.js';
export const privateProjectPart =
  /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.gnupg|\.codex|\.gemini|\.config|\.kube|\.docker|\.azure|\.npmrc|\.netrc|id_rsa|id_ed25519)$|\.(?:pem|key|p12|pfx)$/i;

const hash = (bytes: string | Buffer) =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');
/** Exact immutable platform source; deliberately performs no host filesystem reads. */
export function readSavedProjectSource<T extends ProjectRuntimeArguments>(
  command: T,
) {
  const source = RuntimeSavedProjectSourceSchema.parse(command.projectSource);
  if (
    !runtimeContractEqual(
      command.files,
      source.snapshot.files.map(({ path, sha256 }) => ({ path, sha256 })),
    )
  )
    throw new LocalCommandError('PROJECT_SOURCE_CHANGED');
  if (
    !source ||
    hash(JSON.stringify(source.snapshot)) !==
      source.project.snapshot.checksum ||
    hash(
      JSON.stringify(
        source.snapshot.files
          .map(({ path, sha256 }) => ({ path, sha256 }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      ),
    ) !== source.snapshot.sourceDigest
  )
    throw new LocalCommandError('PROJECT_SOURCE_CHANGED');
  let total = 0;
  const files = source.snapshot.files.map((f) => {
    if (f.path.split('/').some((p) => privateProjectPart.test(p)))
      throw new LocalCommandError('SENSITIVE_INPUT');
    const bytes = Buffer.from(f.contentBase64, 'base64');
    total += bytes.length;
    if (
      bytes.toString('base64') !== f.contentBase64 ||
      bytes.length !== f.sizeBytes ||
      bytes.length > projectSourceLimits.fileBytes ||
      total > projectSourceLimits.totalBytes ||
      hash(bytes) !== f.sha256
    )
      throw new LocalCommandError('PROJECT_SOURCE_CHANGED');
    return { path: f.path, content: f.contentBase64 };
  });
  return { command, files };
}
