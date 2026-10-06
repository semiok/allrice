import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
/** Shared operator/CI reader. Reads immutable tracked blobs, never credentials or build caches. */
export function readRepositoryGitMaterial(root, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('REPOSITORY_SHA_INVALID');
  const rows = execFileSync('git', ['ls-tree', '-lr', '-z', sha], {
    cwd: root,
    maxBuffer: 2_000_000,
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [metadata, path] = line.split('\t'),
        [mode, kind, oid, size] = metadata.split(/\s+/);
      if (
        !path ||
        kind !== 'blob' ||
        !['100644', '100755'].includes(mode) ||
        !/^[a-f0-9]{40}$/.test(oid) ||
        !/^\d+$/.test(size)
      )
        throw Error('REPOSITORY_GIT_ENTRY_UNSUPPORTED');
      return { path, mode, oid, size: Number(size) };
    });
  if (
    !rows.length ||
    rows.length > 4096 ||
    rows.some((r) => r.size > 2_000_000) ||
    rows.reduce((n, r) => n + r.size, 0) > 32_000_000
  )
    throw Error('REPOSITORY_SOURCE_LIMIT');
  const blobs = execFileSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input: rows.map((r) => r.oid).join('\n') + '\n',
    maxBuffer: 34_000_000,
  });
  let offset = 0;
  const files = rows.map((row) => {
    const end = blobs.indexOf(10, offset);
    if (
      end < offset ||
      blobs.subarray(offset, end).toString('ascii') !==
        `${row.oid} blob ${row.size}`
    )
      throw Error('REPOSITORY_GIT_READ_FAILED');
    const bytes = blobs.subarray(end + 1, end + 1 + row.size);
    offset = end + 2 + row.size;
    if (bytes.length !== row.size || blobs[offset - 1] !== 10)
      throw Error('REPOSITORY_GIT_READ_FAILED');
    return {
      path: row.path,
      mode: row.mode,
      sizeBytes: row.size,
      checksum: ciDigest(bytes),
      contentBase64: bytes.toString('base64'),
    };
  });
  if (offset !== blobs.length) throw Error('REPOSITORY_GIT_READ_FAILED');
  return { version: 1, files };
}
export const ciDigest = (value) =>
  'sha256:' + createHash('sha256').update(value).digest('hex');
export function ciMaterialDigest(files) {
  return ciDigest(
    JSON.stringify(
      files
        .map(({ path, mode, sizeBytes, checksum }) => ({
          path,
          mode,
          sizeBytes,
          checksum,
        }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    ),
  );
}
