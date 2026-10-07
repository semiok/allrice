import { randomUUID, createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  open,
  unlink,
  symlink,
  lstat,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { projectFixture } from '../../../apps/rice-bridge/test/project-fixture.js';
import { projectStagingArchives } from './project-staging.js';
import {
  nodeProjectArchiveAssembly,
  pythonProjectArchiveAssembly,
} from './project-archive-assembly.js';

const run = promisify(execFile);
async function fixture(test: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'allrice-archive-assembly-'));
  try {
    await mkdir(join(root, '.allrice'), { recursive: true });
    await test(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function assemble(
  root: string,
  a: unknown,
  interpreter: 'node' | 'python',
) {
  if (interpreter === 'node')
    return runInNewContext(
      `(async()=>{${nodeProjectArchiveAssembly};await assembleArchives()})()`,
      {
        root,
        a,
        open,
        unlink,
        createHash,
        fsConstants,
        Buffer,
        mkdir,
        lstat,
      },
    );
  await run('/usr/bin/python3', [
    '-c',
    `import os,stat,re,hashlib,json\nROOT=${JSON.stringify(root)}\na=json.loads(${JSON.stringify(JSON.stringify(a))})\n${pythonProjectArchiveAssembly}\nassemble_archives()`,
  ]);
}
it.each(['node', 'python'] as const)(
  'keeps every staging request below24MB and verifies the complete large archive with %s',
  async (interpreter) => {
    await fixture(async (root) => {
      const f = projectFixture('pnpm'),
        bytes = Buffer.alloc(34_000_001);
      for (let n = 0; n < bytes.length; n += 99991) bytes[n] = n % 251;
      const command = structuredClone(f.command);
      Object.assign(command.arguments.projectPreparation!, {
        resourceProfile: 'web-development',
      });
      const archives = projectStagingArchives({
        command,
        files: f.bundle,
        tool: {
          path: '.allrice/manager.tar.gz',
          bytes: Buffer.from('fixed tool'),
        },
        prepared: { files: [{ path: '.allrice/archives/0.tgz', bytes }] },
        deadlineUnixMs: Date.now() + 60000,
        deadlineReason: 'timeout',
      });
      for (const buffer of archives) {
        expect(buffer.length).toBeLessThanOrEqual(24_000_000);
        const path = join(root, randomUUID() + '.tar');
        await writeFile(path, buffer);
        await run('/usr/bin/tar', ['-xf', path, '-C', root]);
        await unlink(path);
      }
      const config = JSON.parse(
        await readFile(join(root, '.allrice/config.json'), 'utf8'),
      );
      await assemble(root, config, interpreter);
      const actual = await readFile(join(root, '.allrice/archives/0.tgz'));
      expect(actual.length).toBe(bytes.length);
      expect(createHash('sha256').update(actual).digest('hex')).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
      for (const part of config.assemblies[0].parts)
        await expect(readFile(join(root, part))).rejects.toMatchObject({
          code: 'ENOENT',
        });
    });
  },
);
it.each(['node', 'python'] as const)(
  'rejects corrupt, absent and symlink chunks before running an installer with %s',
  async (interpreter) => {
    for (const mode of ['corrupt', 'missing', 'symlink'])
      await fixture(async (root) => {
        await mkdir(join(root, '.allrice/staging'));
        const bytes = Buffer.from('verified archive');
        const part = join(root, '.allrice/staging/0-0.part');
        if (mode === 'corrupt') await writeFile(part, 'corrupted');
        if (mode === 'symlink') {
          await writeFile(join(root, 'outside'), bytes);
          await symlink(join(root, 'outside'), part);
        }
        const a = {
          assemblies: [
            {
              path: '.allrice/archives/0.tgz',
              size: bytes.length,
              checksum: createHash('sha256').update(bytes).digest('hex'),
              parts: ['.allrice/staging/0-0.part'],
            },
          ],
        };
        await expect(assemble(root, a, interpreter)).rejects.toBeDefined();
      });
  },
);
it('standard preparations reject a large archive before staging', () => {
  const f = projectFixture('pnpm');
  expect(() =>
    projectStagingArchives({
      command: f.command,
      files: f.bundle,
      tool: { path: '.allrice/manager.tar.gz', bytes: Buffer.from('tool') },
      prepared: {
        files: [
          { path: '.allrice/archives/0.tgz', bytes: Buffer.alloc(23_000_001) },
        ],
      },
      deadlineUnixMs: Date.now() + 60000,
      deadlineReason: 'timeout',
    }),
  ).toThrow('PROJECT_DEPENDENCY_LIMIT');
});
