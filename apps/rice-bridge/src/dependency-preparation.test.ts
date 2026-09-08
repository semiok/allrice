import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RuntimeLocalCommandSchema,
  RuntimeDependencyPreparationSchema,
  localCommandToolchainImageV1,
} from '@allrice/contracts';
import { dependencyFixture } from '../test/dependency-fixture.js';
import {
  validateDependencyInputs,
  prepareDependencyArchives,
} from './dependency-preparation.js';
import { publicRegistryAddress } from './npm-registry-download.js';
import { LocalCommandRunner } from './local-command-runner.js';

const roots: string[] = [];
const containers: {
  runner: LocalCommandRunner;
  attemptId: string;
  containerId: string;
}[] = [];
afterEach(async () => {
  for (const r of containers.splice(0))
    await r.runner.cleanup(r.attemptId, r.containerId);
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
function input(script?: string) {
  const f = dependencyFixture(script);
  const files = Object.entries(f.files).map(([path, bytes]) => ({
    path,
    content: bytes.toString('base64'),
  }));
  const command = RuntimeLocalCommandSchema.parse({
    capability: 'local.process.execute',
    arguments: {
      executable: '/usr/local/bin/node',
      args: ['verify.cjs'],
      path: '.',
      dependencies: {
        manager: 'npm',
        strategy: 'locked_ci',
        registry: 'https://registry.npmjs.org',
        scripts: 'disabled',
        packages: [f.pkg],
      },
      files: Object.entries(f.files).map(([path, bytes]) => ({
        path,
        sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      })),
      imageDigest: localCommandToolchainImageV1,
      isolation: 'local-vm-container-v1',
      network: 'none',
      limits: {
        timeoutMs: 15000,
        outputBytes: 8192,
        memoryMiB: 256,
        cpuMillis: 1000,
        pids: 64,
      },
    },
  });
  return { ...f, files, command };
}
it('P09-b binds source/version/scripts and rejects unsafe or duplicate package specs', () => {
  const f = input(),
    spec = f.command.arguments.dependencies!;
  for (const patch of [
    { registry: 'http://localhost' },
    { manager: 'pnpm' },
    { scripts: 'allow_host' },
    { packages: [{ ...f.pkg, name: '../secrets' }] },
    { packages: [f.pkg, f.pkg] },
  ])
    expect(
      RuntimeDependencyPreparationSchema.safeParse({ ...spec, ...patch })
        .success,
    ).toBe(false);
  expect(
    RuntimeLocalCommandSchema.safeParse({
      ...f.command,
      arguments: {
        ...f.command.arguments,
        diagnostics: { kind: 'node_project' },
      },
    }).success,
  ).toBe(false);
});
it.each([
  '127.0.0.1',
  '10.0.0.1',
  '169.254.169.254',
  '100.64.0.1',
  '198.18.0.153',
  '192.0.2.1',
  '224.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
])('P09-b rejects non-public/unsupported DNS destination %s', (ip) =>
  expect(publicRegistryAddress(ip)).toBe(false),
);
it('P09-b accepts only public IPv4 routing', () =>
  expect(publicRegistryAddress('104.16.26.34')).toBe(true));
it('P09-b validates exact lock and hash without implicitly downloading or repairing', async () => {
  const f = input();
  expect(() => validateDependencyInputs(f.command, f.files)).not.toThrow();
  expect(
    await prepareDependencyArchives(f.command, f.files, {
      signal: AbortSignal.timeout(1000),
    }),
  ).toHaveLength(1);
  const mutated = f.files.map((x) =>
    x.path === 'package-lock.json'
      ? {
          ...x,
          content: Buffer.from(
            JSON.stringify({
              ...f.lock,
              packages: {
                ...f.lock.packages,
                [`node_modules/${f.pkg.name}`]: {
                  version: '2.0.0',
                  resolved: 'http://localhost/evil',
                  integrity: f.pkg.integrity,
                },
              },
            }),
          ).toString('base64'),
        }
      : x,
  );
  expect(() => validateDependencyInputs(f.command, mutated)).toThrow(
    'DEPENDENCY_LOCK_MISMATCH',
  );
  f.command.arguments.dependencies!.packages[0]!.integrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
  await expect(
    prepareDependencyArchives(f.command, f.files, {
      signal: AbortSignal.timeout(1000),
    }),
  ).rejects.toThrow('DEPENDENCY_LOCK_MISMATCH');
});
it('P09-b fails closed for missing archives, integrity mismatch and revoked leases', async () => {
  const f = input();
  await expect(
    prepareDependencyArchives(
      f.command,
      f.files.filter((x) => x.path !== 'package.tgz'),
      { signal: AbortSignal.timeout(1000) },
    ),
  ).rejects.toThrow('DEPENDENCY_ARCHIVE_REQUIRED');
  await expect(
    prepareDependencyArchives(
      f.command,
      f.files.map((x) =>
        x.path === 'package.tgz'
          ? { ...x, content: Buffer.from('changed').toString('base64') }
          : x,
      ),
      { signal: AbortSignal.timeout(1000) },
    ),
  ).rejects.toThrow('DEPENDENCY_INTEGRITY_MISMATCH');
  await expect(
    prepareDependencyArchives(f.command, f.files, {
      signal: AbortSignal.timeout(1000),
      maintainLease: async () => false,
    }),
  ).rejects.toThrow('EXECUTION_REVOKED');
});
const socket = process.env.ALLRICE_LOCAL_DOCKER_TEST_SOCKET;
(socket ? describe : describe.skip)(
  'P09-b actual npm installation and verification inside fixed VM',
  () => {
    async function run(
      script?: string,
      allow = false,
      source?: string,
      abort?: AbortSignal,
      onOutput?: (text: string) => void,
    ) {
      if (!socket?.endsWith('/.colima/allrice-b2/docker.sock'))
        throw Error('dedicated test VM required');
      const f = input(script);
      f.command.arguments.dependencies!.scripts = allow
        ? 'allow_in_isolated_copy'
        : 'disabled';
      if (source) {
        f.files.find((x) => x.path === 'verify.cjs')!.content =
          Buffer.from(source).toString('base64');
        f.command.arguments.files.find((x) => x.path === 'verify.cjs')!.sha256 =
          `sha256:${createHash('sha256').update(source).digest('hex')}`;
      }
      const root = await mkdtemp(join(tmpdir(), 'allrice-p09b-vm-'));
      roots.push(root);
      for (const file of f.files)
        await writeFile(
          join(root, file.path),
          Buffer.from(file.content, 'base64'),
        );
      const runner = new LocalCommandRunner({
          socketPath: socket,
          imageDigest: localCommandToolchainImageV1,
        }),
        attemptId = randomUUID();
      const result = await runner.execute(root, f.command, {
        attemptId,
        signal: abort,
        onOutput: (chunk) => onOutput?.(chunk.text),
      });
      containers.push({ runner, attemptId, containerId: result.containerId });
      for (const file of f.files)
        expect(await readFile(join(root, file.path))).toEqual(
          Buffer.from(file.content, 'base64'),
        );
      await expect(
        readFile(join(root, 'node_modules', f.pkg.name, 'index.js')),
      ).rejects.toThrow();
      return result;
    }
    it('installs an exact real npm archive and runs a verification using that dependency', async () => {
      const r = await run();
      expect(r.reason).toBe('exited');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('dependency verification: 42');
      expect(r.dependencies?.status).toBe(
        'installed_and_verification_succeeded',
      );
    }, 30000);
    it('disables lifecycle scripts unless this exact installation grants them', async () => {
      const r = await run('node -e "process.exit(42)"');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('dependency verification: 42');
      const denied = await run('node -e "process.exit(42)"', true);
      expect(denied.exitCode).not.toBe(0);
      expect(denied.stdout).not.toContain('dependency verification: 42');
      expect(denied.dependencies?.status).toBe(
        'installation_or_verification_failed',
      );
    }, 60000);
    it('authorized installation scripts remain unable to write outside the sandbox', async () => {
      const r = await run(
        `node -e "require('fs').writeFileSync('/outside','escape')"`,
        true,
      );
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toMatch(/EROFS|EACCES/);
    }, 30000);
    it('cancels running verification and confirms the entire container stopped', async () => {
      const abort = new AbortController();
      let started = false;
      const r = await run(
        undefined,
        false,
        'console.log("p09b-verification-running");setInterval(()=>{},100)',
        abort.signal,
        (text) => {
          if (text.split('\n').includes('p09b-verification-running')) {
            started = true;
            abort.abort();
          }
        },
      );
      expect(started).toBe(true);
      expect(r.reason).toBe('canceled');
      expect(r.stopped).toBe(true);
    }, 30000);
    it('cancels a truly running installation script and its detached descendants, not just a queued request', async () => {
      const abort = new AbortController();
      let started = false;
      const r = await run(
        `node -e "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},100)'],{detached:true,stdio:'ignore'}).unref();console.log('p09b-install-running');setInterval(()=>{},100)"`,
        true,
        undefined,
        abort.signal,
        (text) => {
          if (text.split('\n').includes('p09b-install-running')) {
            started = true;
            abort.abort();
          }
        },
      );
      expect(started).toBe(true);
      expect(r.reason).toBe('canceled');
      expect(r.stopped).toBe(true);
      expect(r.stdout).not.toContain('dependency verification: 42');
    }, 30000);
  },
);
