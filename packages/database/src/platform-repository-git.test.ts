import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  gitBlobId,
  repositoryGitTree,
  repositoryCommitIdentity,
} from './platform-repository-git.ts';
import { repositoryDigest } from './platform-repository-source.ts';

describe('fixed repository Git identity against native Git', () => {
  it('matches native blobs and trees with directory ordering, UTF-8 and executable modes', () => {
    const root = mkdtempSync(join(tmpdir(), 'allrice-git-identity-'));
    const files = [
      { path: 'a.c', mode: '100644' as const, bytes: Buffer.from('first\n') },
      {
        path: 'a/file.txt',
        mode: '100644' as const,
        bytes: Buffer.from('nested\n'),
      },
      {
        path: 'a0',
        mode: '100644' as const,
        bytes: Buffer.from('after directory\n'),
      },
      {
        path: '脚本/run.sh',
        mode: '100755' as const,
        bytes: Buffer.from('#!/bin/sh\necho ok\n'),
      },
    ];
    try {
      execFileSync('git', ['init', '-q', root]);
      execFileSync('git', ['config', 'core.fileMode', 'true'], { cwd: root });
      for (const file of files) {
        mkdirSync(join(root, file.path, '..'), { recursive: true });
        writeFileSync(join(root, file.path), file.bytes);
        chmodSync(
          join(root, file.path),
          file.mode === '100755' ? 0o755 : 0o644,
        );
        expect(gitBlobId(file.bytes)).toBe(
          execFileSync('git', ['hash-object', '--stdin'], {
            input: file.bytes,
            cwd: root,
            encoding: 'utf8',
          }).trim(),
        );
      }
      execFileSync('git', ['add', '.'], { cwd: root });
      const expected = execFileSync('git', ['write-tree'], {
        cwd: root,
        encoding: 'utf8',
      }).trim();
      const archive = {
        version: 1 as const,
        files: files.map((f) => ({
          path: f.path,
          mode: f.mode,
          sizeBytes: f.bytes.length,
          checksum: repositoryDigest(f.bytes),
          contentBase64: f.bytes.toString('base64'),
        })),
      };
      expect(repositoryGitTree(archive)).toBe(expected);
      expect(
        repositoryGitTree({ ...archive, files: [...archive.files].reverse() }),
      ).toBe(expected);
      expect(
        repositoryGitTree({
          ...archive,
          files: archive.files.map((f) => ({ ...f, mode: '100644' })),
        }),
      ).not.toBe(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('freezes the exact commit object that native Git produces', () => {
    const tree = 'e'.repeat(40),
      parent = 'b'.repeat(40);
    const metadata = {
      login: 'fixture-author',
      userId: 123,
      timestamp: '2026-10-06T00:00:00Z',
      message: 'Fixed repository candidate',
    };
    const identity = repositoryCommitIdentity(tree, parent, metadata);
    const signature =
      'fixture-author <123+fixture-author@users.noreply.github.com> 1791244800 +0000';
    const bytes = Buffer.from(
      `tree ${tree}\nparent ${parent}\nauthor ${signature}\ncommitter ${signature}\n\nFixed repository candidate\n`,
    );
    expect(identity.sha).toBe(
      execFileSync('git', ['hash-object', '-t', 'commit', '--stdin'], {
        input: bytes,
        encoding: 'utf8',
      }).trim(),
    );
    expect(repositoryCommitIdentity(tree, parent, metadata)).toEqual(identity);
    expect(identity.payload.author).toEqual(identity.payload.committer);
  });
  it('rejects metadata and material that could change the deterministic object identity', () => {
    const metadata = {
      login: 'fixture',
      userId: 1,
      timestamp: '2026-10-06T00:00:00Z',
      message: 'candidate',
    };
    for (const change of [
      { login: 'bad\nname' },
      { message: 'extra\nheader' },
      { userId: 0 },
      { timestamp: '2026-10-06T00:00:00.123Z' },
    ])
      expect(() =>
        repositoryCommitIdentity('a'.repeat(40), 'b'.repeat(40), {
          ...metadata,
          ...change,
        }),
      ).toThrow('REPOSITORY_COMMIT_METADATA_INVALID');
    expect(() =>
      repositoryGitTree({
        version: 1,
        files: [
          {
            path: '.env',
            mode: '100644',
            sizeBytes: 1,
            checksum: repositoryDigest('x'),
            contentBase64: 'eA==',
          },
        ],
      }),
    ).toThrow('REPOSITORY_PATH_UNSAFE');
  });
});
