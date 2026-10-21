import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  repositoryMaterialDigest,
  repositoryDependencyDigest,
  repositoryGitTree,
  validateRepositoryArchive,
  repositoryDigest,
  readRepositoryArchive,
} from '@allrice/database';
import {
  RepositoryCiReceiptSchema,
  repositorySourceLimits,
  RepositoryBaselineSchema,
  RepositoryVerificationSchema,
  repairProfileId,
} from '@allrice/database/technical-contracts';
import {
  readRepositoryGitMaterial,
  ciMaterialDigest,
  repositoryGitMaterialLimits,
} from './repository-git-material.mjs';

describe('immutable CI material capture and final production inventory', () => {
  it('keeps CI and registered source bounds aligned, accepts the exact total bound and rejects overflow without omitting blobs', () => {
    expect(repositoryGitMaterialLimits).toEqual({
      files: repositorySourceLimits.files,
      fileBytes: repositorySourceLimits.fileBytes,
      totalBytes: repositorySourceLimits.totalBytes,
    });
    expect(repositorySourceLimits.jsonBytes).toBe(60_000_000);
    expect(repositorySourceLimits.archiveBytes).toBe(12_000_000);
    const root = mkdtempSync(join(tmpdir(), 'allrice-ci-source-bound-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    try {
      git('init', '-q');
      git('config', 'user.name', 'Fixture');
      git('config', 'user.email', 'fixture@example.test');
      const chunk = Buffer.alloc(repositorySourceLimits.fileBytes, 'x');
      const count = repositorySourceLimits.totalBytes / chunk.length;
      expect(Number.isInteger(count)).toBe(true);
      const lock = Buffer.from('lockfileVersion: 9\n');
      writeFileSync(join(root, 'pnpm-lock.yaml'), lock);
      for (let i = 0; i < count; i++)
        writeFileSync(
          join(root, `source-${i}.txt`),
          i === 0 ? chunk.subarray(lock.length) : chunk,
        );
      git('add', '.');
      git('commit', '-qm', 'exact source limit');
      const archive = readRepositoryGitMaterial(root, git('rev-parse', 'HEAD'));
      expect(archive.files).toHaveLength(count + 1);
      expect(archive.files.reduce((n, f) => n + f.sizeBytes, 0)).toBe(
        repositorySourceLimits.totalBytes,
      );
      expect(validateRepositoryArchive(archive).files).toHaveLength(count + 1);
      expect(ciMaterialDigest(archive.files)).toBe(
        repositoryMaterialDigest(archive.files),
      );
      expect(repositoryGitTree(archive)).toBe(git('rev-parse', 'HEAD^{tree}'));
      expect(Buffer.byteLength(JSON.stringify(archive))).toBeLessThan(
        repositorySourceLimits.jsonBytes,
      );
      const packed = gzipSync(Buffer.from(JSON.stringify(archive)));
      const baseline = RepositoryBaselineSchema.parse({
        version: 1,
        id: randomUUID(),
        repositoryId: 'semiok/allrice',
        sourceSha: git('rev-parse', 'HEAD'),
        gitTree: git('rev-parse', 'HEAD^{tree}'),
        sourceDigest: repositoryMaterialDigest(archive.files),
        rootLockChecksum: archive.files.find(
          (f) => f.path === 'pnpm-lock.yaml',
        )!.checksum,
        dependencyConfigurationDigest: repositoryDependencyDigest(
          archive.files,
        ),
        archiveChecksum: repositoryDigest(packed),
        archiveBytes: packed.length,
        fileCount: archive.files.length,
        sourceBytes: repositorySourceLimits.totalBytes,
        observedDevSha: '3'.repeat(40),
        registeredAt: new Date().toISOString(),
        materializer: 'git-tracked-json-gzip-v1',
        profileId: repairProfileId,
        dependencyMode: 'runtime_builtins_only',
        monorepoDependenciesInstalled: false,
      });
      expect(readRepositoryArchive(packed, baseline).files).toHaveLength(
        count + 1,
      );
      expect(
        RepositoryBaselineSchema.safeParse({
          ...baseline,
          sourceBytes: repositorySourceLimits.totalBytes + 1,
        }).success,
      ).toBe(false);
      for (const report of RepositoryVerificationSchema.options) {
        expect(
          report.shape.sourceBytes.safeParse(repositorySourceLimits.totalBytes)
            .success,
        ).toBe(true);
        expect(
          report.shape.sourceBytes.safeParse(
            repositorySourceLimits.totalBytes + 1,
          ).success,
        ).toBe(false);
      }
      writeFileSync(join(root, 'overflow.txt'), 'x');
      git('add', '.');
      git('commit', '-qm', 'one byte over source limit');
      expect(() =>
        readRepositoryGitMaterial(root, git('rev-parse', 'HEAD')),
      ).toThrow('REPOSITORY_SOURCE_LIMIT');
      expect(() =>
        validateRepositoryArchive({
          ...archive,
          files: [
            ...archive.files,
            {
              path: 'overflow.txt',
              mode: '100644',
              sizeBytes: 1,
              checksum: repositoryDigest('x'),
              contentBase64: Buffer.from('x').toString('base64'),
            },
          ],
        }),
      ).toThrow('REPOSITORY_SOURCE_CHANGED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
  it('matches the product material/tree identity, keeps merge and head SHAs separate, and refuses missing outputs or changed tracked source', () => {
    const root = mkdtempSync(join(tmpdir(), 'allrice-ci-receipt-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const file = (name: string, bytes: string) => {
      mkdirSync(resolve(root, name, '..'), { recursive: true });
      writeFileSync(join(root, name), bytes);
    };
    try {
      git('init', '-q');
      git('config', 'user.name', 'Fixture');
      git('config', 'user.email', 'fixture@example.test');
      file(
        'package.json',
        JSON.stringify({
          scripts: { build: 'pnpm -r --if-present run build' },
        }),
      );
      file('pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - packages/*\n');
      file('pnpm-lock.yaml', 'lockfileVersion: 9\n');
      file('.github/workflows/ci.yml', 'name: CI\n');
      file(
        'packages/contracts/package.json',
        JSON.stringify({
          name: '@allrice/contracts',
          scripts: { build: 'tsc -p tsconfig.build.json' },
        }),
      );
      git('add', '.');
      git('commit', '-qm', 'fixture');
      const sha = git('rev-parse', 'HEAD'),
        archive = readRepositoryGitMaterial(root, sha);
      expect(ciMaterialDigest(archive.files)).toBe(
        repositoryMaterialDigest(archive.files),
      );
      expect(repositoryGitTree(archive)).toBe(git('rev-parse', 'HEAD^{tree}'));
      const script = resolve('scripts/acceptance/platform/repository-ci.mjs');
      const run = (mode: 'capture' | 'finish') =>
        execFileSync(
          process.execPath,
          [
            script,
            mode,
            '--capture=' + join(root, 'capture.json'),
            '--output=' +
              join(root, mode === 'capture' ? 'capture.json' : 'receipt.json'),
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              GITHUB_REPOSITORY: 'semiok/allrice',
              GITHUB_REPOSITORY_ID: '1323769790',
              GITHUB_RUN_ID: '123',
              GITHUB_RUN_ATTEMPT: '2',
              GITHUB_JOB: 'validate',
              GITHUB_EVENT_NAME: 'pull_request',
              GITHUB_EVENT_PATH: join(root, 'event.json'),
              RUNNER_OS: 'Linux',
              RUNNER_ARCH: 'X64',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
      file(
        'event.json',
        JSON.stringify({
          pull_request: {
            number: 312,
            head: { sha: 'a'.repeat(40) },
            base: { sha: 'b'.repeat(40) },
          },
        }),
      );
      run('capture');
      const capture = JSON.parse(
        readFileSync(join(root, 'capture.json'), 'utf8'),
      );
      expect(capture.dependencyConfigurationDigest).toBe(
        repositoryDependencyDigest(archive.files),
      );
      expect(() => run('finish')).toThrow();
      file(
        'packages/contracts/dist/index.js',
        'export const compiled = true;\n',
      );
      run('finish');
      const receipt = RepositoryCiReceiptSchema.parse(
        JSON.parse(readFileSync(join(root, 'receipt.json'), 'utf8')),
      );
      expect(receipt).toMatchObject({
        checkoutSha: sha,
        headSha: 'a'.repeat(40),
        runAttempt: 2,
        build: { packages: [{ name: '@allrice/contracts', fileCount: 1 }] },
      });
      rmSync(join(root, 'receipt.json'));
      file('package.json', JSON.stringify({ scripts: { build: 'different' } }));
      expect(() => run('finish')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
