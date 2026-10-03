import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  makeProjectSnapshot,
  projectSourceFile,
  parseProjectSnapshotBytes,
  applyProjectProposal,
  projectFileText,
} from './project-source.ts';

describe('complete project source checkpoints', () => {
  it('preserves locks and binary inputs through text edits and removal', () => {
    const original = makeProjectSnapshot(randomUUID(), [
      projectSourceFile('main.ts', Buffer.from('bad();\n')),
      projectSourceFile(
        'pnpm-lock.yaml',
        Buffer.from('lockfileVersion: 9.0\n'),
      ),
      projectSourceFile('icon.bin', Buffer.from([0, 255, 2])),
    ]);
    const changed = applyProjectProposal(
      original,
      {
        files: [
          { path: 'main.ts', before: 'bad();\n', after: 'good();\n' },
          { path: 'README.md', before: null, after: 'Project\n' },
        ],
      },
      {
        kind: 'artifact',
        id: randomUUID(),
        checksum: 'sha256:' + 'a'.repeat(64),
      },
    );
    expect(changed.files.find((f) => f.path === 'pnpm-lock.yaml')).toEqual(
      original.files.find((f) => f.path === 'pnpm-lock.yaml'),
    );
    expect(changed.files.find((f) => f.path === 'icon.bin')).toEqual(
      original.files.find((f) => f.path === 'icon.bin'),
    );
    expect(
      projectFileText(changed.files.find((f) => f.path === 'main.ts')!),
    ).toBe('good();\n');
    expect(() =>
      projectFileText(changed.files.find((f) => f.path === 'icon.bin')!),
    ).toThrow('binary_file');
    expect(() =>
      applyProjectProposal(
        changed,
        { files: [{ path: 'main.ts', before: 'bad();\n', after: null }] },
        changed.parent!,
      ),
    ).toThrow('baseline_conflict');
  });
  it('rejects byte corruption, noncanonical base64 and forged source digest', () => {
    const source = makeProjectSnapshot(randomUUID(), [
      projectSourceFile('main.py', Buffer.from('print(1)')),
    ]);
    for (const corrupt of [
      { ...source, sourceDigest: 'sha256:' + 'f'.repeat(64) },
      {
        ...source,
        files: [
          {
            ...source.files[0],
            contentBase64: source.files[0]!.contentBase64 + '\n',
          },
        ],
      },
      { ...source, files: [{ ...source.files[0], sizeBytes: 99 }] },
    ])
      expect(() =>
        parseProjectSnapshotBytes(Buffer.from(JSON.stringify(corrupt))),
      ).toThrow();
  });
  it('bounds actual UTF-8 bytes and rejects aliases, traversal and file/directory conflicts', () => {
    expect(() =>
      projectSourceFile('large.ts', Buffer.from('米'.repeat(67000))),
    ).toThrow('source_byte_limit');
    for (const paths of [
      ['A.ts', 'a.ts'],
      ['é.ts', 'e\u0301.ts'],
      ['app', 'app/main.ts'],
      ['../main.ts'],
    ])
      expect(() =>
        makeProjectSnapshot(
          randomUUID(),
          paths.map((path) => projectSourceFile(path, Buffer.from('x'))),
        ),
      ).toThrow();
  });
});
