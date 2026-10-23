import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { projectSourceArchive } from './project-delivery.ts';
import { makeProjectSnapshot, projectSourceFile } from './project-source.ts';
import { projectSourcePackageReceipt } from './project-source-package.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const checksum = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function fixture(files: Record<string, string>) {
  const snapshot = makeProjectSnapshot(
    id(1),
    Object.entries(files).map(([path, text]) =>
      projectSourceFile(path, Buffer.from(text)),
    ),
  );
  const bytes = projectSourceArchive(snapshot);
  const project = {
    projectId: snapshot.projectId,
    snapshot: {
      kind: 'storage_object' as const,
      id: id(2),
      checksum: checksum(Buffer.from(JSON.stringify(snapshot))),
    },
  };
  const artifact = {
    objectId: id(3),
    versionId: id(4),
    checksum: checksum(bytes),
  };
  return {
    snapshot,
    project,
    artifact,
    bytes,
    receipt: projectSourcePackageReceipt({ project, snapshot, artifact }),
  };
}

describe('source ZIP disclosure', () => {
  it('lists actual archived members even when README claims an unshipped generated file', () => {
    const f = fixture({
      'README.md': 'ZIP includes data-v2.json and dist/index.html.\n',
      'prepare-v2.cjs': '// Generates data-v2.json only when executed.\n',
    });
    const archived = unzipSync(f.bytes);
    expect(f.receipt.files).toEqual(
      Object.entries(archived).map(([path, bytes]) => ({
        path,
        sizeBytes: bytes.byteLength,
        sha256: checksum(bytes),
      })),
    );
    expect(f.receipt.files.map((file) => file.path)).toEqual([
      'prepare-v2.cjs',
      'README.md',
    ]);
    expect(f.receipt).toMatchObject({
      kind: 'source-only',
      project: f.project,
      sourceDigest: f.snapshot.sourceDigest,
      artifact: f.artifact,
    });
    expect(f.receipt).not.toHaveProperty('complete');
    expect(f.receipt.files[0]).not.toHaveProperty('contentBase64');
    expect(projectSourceArchive(f.snapshot)).toEqual(f.bytes);
  });

  it('includes generated-looking files only when their exact bytes are saved in the snapshot', () => {
    const f = fixture({
      'README.md': 'This snapshot includes the saved HTML.\n',
      'dist/index.html': '<!doctype html><p>Saved output</p>\n',
      'data-v2.json': '{"rows":[]}\n',
    });
    const archived = unzipSync(f.bytes);
    expect(f.receipt.files.map((file) => file.path).sort()).toEqual(
      Object.keys(archived).sort(),
    );
    expect(
      f.receipt.files.find((file) => file.path === 'dist/index.html'),
    ).toEqual({
      path: 'dist/index.html',
      sizeBytes: archived['dist/index.html']!.byteLength,
      sha256: checksum(archived['dist/index.html']!),
    });
    expect(f.receipt.kind).toBe('source-only');
  });

  it('keeps replay metadata stable and does not alias the source or project reference', () => {
    const f = fixture({ 'main.ts': 'export const value = 1;\n' });
    expect(
      projectSourcePackageReceipt({
        project: f.project,
        snapshot: f.snapshot,
        artifact: f.artifact,
      }),
    ).toEqual(f.receipt);
    f.receipt.files[0]!.path = 'changed';
    f.receipt.project.snapshot.id = id(5);
    f.receipt.artifact.objectId = id(6);
    expect(f.snapshot.files[0]!.path).toBe('main.ts');
    expect(f.project.snapshot.id).toBe(id(2));
    expect(f.artifact.objectId).toBe(id(3));
  });
});
