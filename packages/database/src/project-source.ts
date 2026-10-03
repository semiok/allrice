import { createHash } from 'node:crypto';
import {
  ProjectSnapshotSchema,
  projectSourceLimits,
  developmentPathsOverlap,
  type ProjectSnapshot,
  type RuntimeContentRef,
  type ProjectWorkspaceCommand,
} from '@allrice/contracts';

export class ProjectWorkspaceError extends Error {
  constructor(readonly code: string) {
    super(`project_${code}`);
  }
}
export function projectFail(code: string): never {
  throw new ProjectWorkspaceError(code);
}
export const projectHash = (bytes: Uint8Array | string) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
/** Same sorted path/SHA manifest as the existing project installer. */
export function projectSnapshotDigest(
  files: { path: string; sha256: string }[],
) {
  return projectHash(
    JSON.stringify(
      files
        .map(({ path, sha256 }) => ({ path, sha256 }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    ),
  );
}
export function projectSourceFile(path: string, bytes: Uint8Array) {
  if (bytes.byteLength > projectSourceLimits.fileBytes)
    projectFail('source_byte_limit');
  return {
    path,
    sha256: projectHash(bytes),
    sizeBytes: bytes.byteLength,
    contentBase64: Buffer.from(bytes).toString('base64'),
  };
}
export function makeProjectSnapshot(
  projectId: string,
  files: ProjectSnapshot['files'],
  lineage: {
    source?: RuntimeContentRef;
    parent?: RuntimeContentRef;
    inputs?: RuntimeContentRef[];
  } = {},
) {
  const snapshot = ProjectSnapshotSchema.parse({
    version: 1,
    projectId,
    sourceDigest: projectSnapshotDigest(files),
    files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
    ...lineage,
  });
  parseProjectSnapshotBytes(Buffer.from(JSON.stringify(snapshot)));
  return snapshot;
}
export function parseProjectSnapshotBytes(bytes: Uint8Array) {
  if (bytes.byteLength > projectSourceLimits.snapshotBytes)
    projectFail('snapshot_byte_limit');
  const snapshot = ProjectSnapshotSchema.parse(
    JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)),
  );
  for (const file of snapshot.files) {
    const data = Buffer.from(file.contentBase64, 'base64');
    if (
      data.toString('base64') !== file.contentBase64 ||
      data.byteLength !== file.sizeBytes ||
      projectHash(data) !== file.sha256
    )
      projectFail('source_changed');
  }
  if (projectSnapshotDigest(snapshot.files) !== snapshot.sourceDigest)
    projectFail('source_changed');
  return snapshot;
}
export function projectFileText(file: ProjectSnapshot['files'][number]) {
  try {
    const text = new TextDecoder('utf8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(Buffer.from(file.contentBase64, 'base64'));
    if (text.includes('\0')) throw Error('binary');
    return text;
  } catch {
    return projectFail('binary_file');
  }
}
export function applyProjectProposal(
  snapshot: ProjectSnapshot,
  proposal: Extract<ProjectWorkspaceCommand, { action: 'apply' }>['proposal'],
  parent: RuntimeContentRef,
) {
  const files = new Map(snapshot.files.map((f) => [f.path, f]));
  if (
    proposal.files.some((f, i) =>
      proposal.files
        .slice(i + 1)
        .some((g) => developmentPathsOverlap(f.path, g.path)),
    )
  )
    projectFail('path_conflict');
  for (const change of proposal.files) {
    const previous = files.get(change.path);
    if ((previous ? projectFileText(previous) : null) !== change.before)
      projectFail('baseline_conflict');
    if (change.after === null) files.delete(change.path);
    else {
      if (change.after.includes('\0')) projectFail('binary_file');
      files.set(
        change.path,
        projectSourceFile(change.path, Buffer.from(change.after, 'utf8')),
      );
    }
  }
  return makeProjectSnapshot(snapshot.projectId, [...files.values()], {
    ...(snapshot.source ? { source: snapshot.source } : {}),
    ...(snapshot.inputs ? { inputs: snapshot.inputs } : {}),
    parent,
  });
}
