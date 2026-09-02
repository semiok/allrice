import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { executeLocalCommand, resolveAuthorizedPath } from './executor.js';

describe('Rice Bridge local executor', () => {
  it('lists, searches and reads inside the authorized root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rice-bridge-'));
    await mkdir(join(root, 'src'));
    await writeFile(
      join(root, 'src', 'rice.ts'),
      'export const rice = true;\n',
    );
    const list = await executeLocalCommand(root, {
      capability: 'local.fs.list',
      arguments: { path: '.', limit: 10 },
    });
    expect(list.output).toEqual([
      expect.objectContaining({ path: 'src', type: 'directory' }),
    ]);
    const search = await executeLocalCommand(root, {
      capability: 'local.fs.search',
      arguments: { path: '.', query: 'rice', limit: 10 },
    });
    expect(search.output).toMatchObject({
      matches: [expect.objectContaining({ path: 'src/rice.ts', line: 1 })],
    });
    const read = await executeLocalCommand(root, {
      capability: 'local.fs.read',
      arguments: { path: 'src/rice.ts', maxBytes: 200_000 },
    });
    expect(read.output).toMatchObject({
      content: 'export const rice = true;\n',
    });
  });

  it('rejects symlinks that escape the authorized root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rice-bridge-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'rice-bridge-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));
    await expect(
      resolveAuthorizedPath(root, 'escape.txt'),
    ).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_GRANT',
    });
  });

  it('blocks common credential files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rice-bridge-secret-'));
    await writeFile(join(root, '.env'), 'TOKEN=secret');
    await expect(
      executeLocalCommand(root, {
        capability: 'local.fs.read',
        arguments: { path: '.env', maxBytes: 200_000 },
      }),
    ).rejects.toMatchObject({ code: 'SENSITIVE_PATH' });
  });

  it('creates files and guards overwrites with the last-read checksum', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rice-bridge-write-'));
    await mkdir(join(root, 'src'));
    const created = await executeLocalCommand(root, {
      capability: 'local.fs.write',
      arguments: {
        path: 'src/rice.ts',
        content: 'export const rice = true;\n',
      },
    });
    expect(created.output).toMatchObject({
      path: 'src/rice.ts',
      created: true,
    });
    await expect(
      executeLocalCommand(root, {
        capability: 'local.fs.write',
        arguments: {
          path: 'src/rice.ts',
          content: 'export const rice = false;\n',
        },
      }),
    ).rejects.toMatchObject({ code: 'WRITE_PRECONDITION_REQUIRED' });
    const checksum = `sha256:${createHash('sha256')
      .update('export const rice = true;\n')
      .digest('hex')}`;
    const updated = await executeLocalCommand(root, {
      capability: 'local.fs.write',
      arguments: {
        path: 'src/rice.ts',
        content: 'export const rice = false;\n',
        expectedSha256: checksum,
      },
    });
    expect(updated.output).toMatchObject({ created: false });
  });

  it('creates one directory at a time and blocks protected paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rice-bridge-mkdir-'));
    const created = await executeLocalCommand(root, {
      capability: 'local.fs.mkdir',
      arguments: { path: 'src' },
    });
    expect(created.output).toEqual({ path: 'src', created: true });
    await expect(
      executeLocalCommand(root, {
        capability: 'local.fs.write',
        arguments: { path: '.git/config', content: 'unsafe' },
      }),
    ).rejects.toMatchObject({ code: 'SENSITIVE_PATH' });
  });
});
