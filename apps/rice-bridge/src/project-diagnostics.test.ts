import { testImage } from '../test/toolchain.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RuntimeLocalCommandSchema,
  RuntimeLocalCommandProfileSchema,
} from '@allrice/contracts';
import { LocalCommandRunner } from './local-command-runner.js';
import { readLocalCommandInputs } from './local-command-inputs.js';
import { diagnosticEvidence } from './project-diagnostics.js';

const roots: string[] = [];
const results: {
  runner: LocalCommandRunner;
  attemptId: string;
  containerId: string;
}[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const r of results.splice(0))
    await r.runner.cleanup(r.attemptId, r.containerId);
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(
  files: Record<string, string> = {
    'package.json': JSON.stringify({
      packageManager: 'npm@10.9.8',
      engines: { node: '>=22' },
      dependencies: { example: '1.0.0' },
      scripts: { postinstall: 'touch P09A_MUST_NOT_RUN' },
    }),
    'package-lock.json': '{}',
  },
) {
  const root = await mkdtemp(join(tmpdir(), 'allrice-p09a-'));
  roots.push(root);
  for (const [name, text] of Object.entries(files))
    await writeFile(join(root, name), text);
  const command = RuntimeLocalCommandSchema.parse({
    capability: 'local.process.execute',
    arguments: {
      executable: '/usr/local/bin/node',
      args: [],
      diagnostics: { kind: 'node_project' },
      path: '.',
      files: Object.entries(files).map(([path, text]) => ({
        path,
        sha256: `sha256:${createHash('sha256').update(text).digest('hex')}`,
      })),
      imageDigest: testImage,
      isolation: 'local-vm-container-v1',
      network: 'none',
      limits: {
        timeoutMs: 10000,
        outputBytes: 8192,
        memoryMiB: 128,
        cpuMillis: 500,
        pids: 32,
      },
    },
  });
  return { root, command, files };
}
it('P09-a rejects extra scripts/commands and unknown profile feature claims', async () => {
  const { command } = await fixture();
  for (const args of [
    { args: ['-e', 'danger'] },
    { executable: '/usr/local/bin/npm' },
    { diagnostics: { kind: 'node_project', repair: true } },
    { diagnostics: { kind: 'node_project', expectedNodeMajor: 0 } },
  ])
    expect(
      RuntimeLocalCommandSchema.safeParse({
        ...command,
        arguments: { ...command.arguments, ...args },
      }).success,
    ).toBe(false);
  const profile = {
    contractVersion: 1,
    backend: 'local-vm-container-v1',
    imageDigest: testImage,
    architecture: 'amd64',
    available: true,
  };
  expect(RuntimeLocalCommandProfileSchema.safeParse(profile).success).toBe(
    true,
  );
  expect(
    RuntimeLocalCommandProfileSchema.safeParse({
      ...profile,
      features: ['shell'],
    }).success,
  ).toBe(false);
});
it('P09-a cannot bless changed manifests or incomplete/failed output', async () => {
  const { command, root } = await fixture();
  await writeFile(join(root, 'package.json'), 'changed');
  await expect(readLocalCommandInputs(root, command)).rejects.toMatchObject({
    code: 'INPUT_VERSION_CHANGED',
  });
  expect(diagnosticEvidence(command, '{', 0, 'exited')).toEqual({});
  expect(diagnosticEvidence(command, '{}', 1, 'exited')).toEqual({});
});
const socket = process.env.ALLRICE_LOCAL_DOCKER_TEST_SOCKET;
(socket ? describe : describe.skip)(
  'P09-a real pinned VM diagnostic (not host version guesses)',
  () => {
    async function run(
      files?: Record<string, string>,
      expected?: { expectedNodeMajor?: number; expectedNpmMajor?: number },
    ) {
      if (!socket?.endsWith('/.colima/allrice-b2/docker.sock'))
        throw Error('dedicated test VM required');
      const runner = new LocalCommandRunner({
        socketPath: socket,
        imageDigest: testImage,
      });
      const f = await fixture(files);
      f.command.arguments.diagnostics = { kind: 'node_project', ...expected };
      const attemptId = randomUUID();
      const result = await runner.execute(f.root, f.command, { attemptId });
      results.push({ runner, attemptId, containerId: result.containerId });
      expect(result.reason).toBe('exited');
      expect(result.exitCode).toBe(0);
      for (const [name, text] of Object.entries(f.files))
        expect(await readFile(join(f.root, name), 'utf8')).toBe(text);
      await expect(
        readFile(join(f.root, 'P09A_MUST_NOT_RUN')),
      ).rejects.toThrow();
      expect(await runner.recover(attemptId, f.command)).toMatchObject({
        diagnostics: result.diagnostics,
      });
      return result;
    }
    it('probes versions, manifests, locks and missing dependencies without running project scripts', async () => {
      vi.stubEnv('PATH', '/untrusted/host/path');
      vi.stubEnv('NODE_OPTIONS', '--require=/untrusted/inject.js');
      const r = await run();
      expect(r.diagnostics).toMatchObject({
        target: 'local_linux_isolated_copy',
        hostToolchain: 'not_inspected',
        platform: 'linux',
        directory: '/workspace',
        project: 'available',
        packageManager: 'npm',
        lockfile: 'package-lock.json',
        dependencies: 'not_prepared',
        node: { version: 'v22.23.2', status: 'available' },
        npm: { status: 'available' },
        nodeEngine: '>=22',
        engineStatus: 'requires_review',
        installedOrRepaired: false,
      });
    }, 30000);
    it('reports explicit mismatches without upgrading or silently using the host binary', async () => {
      const r = await run(
        { 'package.json': '{}' },
        { expectedNodeMajor: 99, expectedNpmMajor: 99 },
      );
      expect(r.diagnostics).toMatchObject({
        dependencies: 'none_declared',
        lockfile: 'missing',
        node: { status: 'version_mismatch' },
        npm: { status: 'version_mismatch' },
      });
    }, 30000);
    it.each([
      [{ 'readme.txt': 'fixture' }, 'manifest_missing', 'missing'],
      [{ 'package.json': 'not json' }, 'manifest_invalid', 'missing'],
      [
        { 'package.json': '{}', 'yarn.lock': '', 'pnpm-lock.yaml': '' },
        'available',
        'multiple',
      ],
    ] as const)(
      'handles missing/invalid manifests and ambiguous locks: %s',
      async (files, project, lockfile) => {
        expect((await run(files)).diagnostics).toMatchObject({
          project,
          lockfile,
        });
      },
      30000,
    );
    it('does not echo arbitrary manifest properties, credentials, scripts or engine injections', async () => {
      const r = await run({
        'package.json': JSON.stringify({
          scripts: { test: 'SUPER_SECRET_FIXTURE' },
          engines: { node: 'https://secret.invalid/?token=fixture' },
          _authToken: 'SUPER_SECRET_FIXTURE',
          packageManager: 'https://secret.invalid',
        }),
      });
      expect(r.stdout).not.toContain('SUPER_SECRET_FIXTURE');
      expect(r.stdout).not.toContain('secret.invalid');
      expect(r.diagnostics).toMatchObject({
        nodeEngine: null,
        engineStatus: 'requires_review',
        packageManager: 'unknown',
      });
    }, 30000);
  },
);
