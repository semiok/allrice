import type { ProjectSnapshot, ProjectVersionRef } from '@allrice/contracts';

type ArtifactIdentity = {
  objectId: string;
  versionId: string;
  checksum: string;
};

/** Describe the same authorized snapshot used for the published source ZIP.
 * This is an inventory, not a verdict on README claims or project correctness. */
export function projectSourcePackageReceipt(input: {
  project: ProjectVersionRef;
  snapshot: ProjectSnapshot;
  artifact: ArtifactIdentity;
}) {
  return {
    kind: 'source-only' as const,
    project: structuredClone(input.project),
    sourceDigest: input.snapshot.sourceDigest,
    artifact: {
      objectId: input.artifact.objectId,
      versionId: input.artifact.versionId,
      checksum: input.artifact.checksum,
    },
    files: input.snapshot.files.map(({ path, sizeBytes, sha256 }) => ({
      path,
      sizeBytes,
      sha256,
    })),
  };
}
