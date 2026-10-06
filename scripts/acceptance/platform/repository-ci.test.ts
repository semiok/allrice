import { execFileSync } from 'node:child_process';
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
} from '@allrice/database';
import { RepositoryCiReceiptSchema } from '@allrice/database/technical-contracts';
import {
  readRepositoryGitMaterial,
  ciMaterialDigest,
} from './repository-git-material.mjs';

describe('immutable CI material capture and final production inventory', () => {
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
