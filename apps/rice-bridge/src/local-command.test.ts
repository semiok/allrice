import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  writeFile,
  rm,
  symlink,
  link,
  readFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BridgeCapabilities,
  BridgeCommandPayloadSchema,
  RuntimeLocalCommandSchema,
} from '@allrice/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { readLocalCommandInputs } from './local-command-inputs.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'allrice-p05-unit-'));
  roots.push(root);
  const source = 'console.log("fixture")';
  await writeFile(join(root, 'test.js'), source);
  const command = RuntimeLocalCommandSchema.parse({
    capability: 'local.process.execute',
    arguments: {
      executable: '/usr/local/bin/node',
      args: ['test.js'],
      path: '.',
      files: [
        {
          path: 'test.js',
          sha256: `sha256:${createHash('sha256').update(source).digest('hex')}`,
        },
      ],
      imageDigest: `sha256:${'a'.repeat(64)}`,
      isolation: 'local-vm-container-v1',
      network: 'none',
      limits: {
        timeoutMs: 1000,
        outputBytes: 4096,
        memoryMiB: 128,
        cpuMillis: 500,
        pids: 32,
      },
    },
  });
  return { root, source, command };
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe('P05 exact inputs and compatibility', () => {
  it('keeps new executable capabilities out of the legacy client', async () => {
    const { command } = await fixture();
    expect(BridgeCommandPayloadSchema.safeParse(command).success).toBe(false);
    expect(BridgeCapabilities).not.toContain('local.process.execute');
  });
  it('copies only the exact manifest and never edits sources', async () => {
    const { root, source, command } = await fixture();
    await writeFile(join(root, 'not-requested.txt'), 'not authorized');
    const value = await readLocalCommandInputs(root, command);
    expect(value.files).toEqual([
      { path: 'test.js', content: Buffer.from(source).toString('base64') },
    ]);
    expect(await readFile(join(root, 'test.js'), 'utf8')).toBe(source);
  });
  it('rejects source changes after approval', async () => {
    const { root, command } = await fixture();
    await writeFile(join(root, 'test.js'), 'changed');
    await expect(readLocalCommandInputs(root, command)).rejects.toMatchObject({
      code: 'INPUT_VERSION_CHANGED',
    });
  });
  it.each(['.env', '.ssh/id_rsa', '.npmrc', 'key.pem', '.gemini/auth.json'])(
    'rejects sensitive manifest path %s',
    async (path) => {
      const { root, command } = await fixture();
      command.arguments.files[0]!.path = path;
      await expect(readLocalCommandInputs(root, command)).rejects.toMatchObject(
        { code: 'SENSITIVE_INPUT' },
      );
    },
  );
  it('rejects symlinks and hardlinks despite matching bytes', async () => {
    const { root, command } = await fixture();
    await symlink(join(root, 'test.js'), join(root, 'alias.js'));
    command.arguments.files[0]!.path = 'alias.js';
    await expect(readLocalCommandInputs(root, command)).rejects.toThrow();
    await link(join(root, 'test.js'), join(root, 'hard.js'));
    command.arguments.files[0]!.path = 'hard.js';
    await expect(readLocalCommandInputs(root, command)).rejects.toMatchObject({
      code: 'UNSAFE_INPUT_FILE',
    });
  });
  it.each([
    '../test.js',
    '/test.js',
    'a/../test.js',
    'a\\test.js',
    'a//test.js',
    'a/./test.js',
  ])('rejects invalid path %s', async (path) => {
    const { command } = await fixture();
    expect(
      RuntimeLocalCommandSchema.safeParse({
        ...command,
        arguments: { ...command.arguments, path },
      }).success,
    ).toBe(false);
  });
  it('rejects unbounded/unknown capabilities and duplicated manifests', async () => {
    const { command } = await fixture();
    for (const patch of [
      { network: 'host' },
      { executable: '/bin/sh' },
      { limits: { ...command.arguments.limits, pids: 1000 } },
      { env: { KEY: randomUUID() } },
    ]) {
      expect(
        RuntimeLocalCommandSchema.safeParse({
          ...command,
          arguments: { ...command.arguments, ...patch },
        }).success,
      ).toBe(false);
    }
    command.arguments.files.push(command.arguments.files[0]!);
    expect(RuntimeLocalCommandSchema.safeParse(command).success).toBe(false);
  });
});
