import { it, expect } from 'vitest';
import { mkdtemp, mkdir, copyFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

it.each(
  ['dev.mjs', 'dev-services.mjs'].flatMap((entry) =>
    ['', 'sha256:' + 'a'.repeat(64)].map((id) => ({ entry, id })),
  ),
)(
  'rejects an unprepared local Worker before database or storage setup ($entry, $id)',
  async ({ entry, id }) => {
    const root = await mkdtemp(join(tmpdir(), 'allrice-dev-preparation-'));
    try {
      await mkdir(join(root, 'scripts'));
      for (const name of [
        'dev.mjs',
        'dev-services.mjs',
        'dev-environment.mjs',
      ]) {
        await copyFile(
          new URL(name, import.meta.url),
          join(root, 'scripts', name),
        );
      }
      const result = spawnSync(
        process.execPath,
        [join(root, 'scripts', entry)],
        {
          cwd: root,
          env: { PATH: process.env.PATH, ALLRICE_DSH_NATIVE_ARTIFACT_ID: id },
          encoding: 'utf8',
          timeout: 5000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('No database setup was started.');
      expect(result.stdout).not.toContain('[setup]');
      await expect(access(join(root, '.local'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
