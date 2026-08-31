import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
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
});
