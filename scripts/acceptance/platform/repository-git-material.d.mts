export function readRepositoryGitMaterial(
  root: string,
  sha: string,
): {
  version: 1;
  files: Array<{
    path: string;
    mode: '100644' | '100755';
    sizeBytes: number;
    checksum: string;
    contentBase64: string;
  }>;
};
export function ciDigest(value: string | Buffer): string;
export function ciMaterialDigest(
  files: Array<{
    path: string;
    mode: string;
    sizeBytes: number;
    checksum: string;
  }>,
): string;
