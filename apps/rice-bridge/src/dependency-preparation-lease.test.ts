import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  RuntimeLocalCommandSchema,
  localCommandToolchainImageV1,
} from '@allrice/contracts';
import { dependencyFixture } from '../test/dependency-fixture.js';

const download = vi.hoisted(() => vi.fn());
vi.mock('./npm-registry-download.js', () => ({
  downloadNpmArchive: download,
}));
import { prepareDependencyArchives } from './dependency-preparation.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  download.mockReset();
});

function fixture() {
  const f = dependencyFixture();
  const pkg = {
    name: f.pkg.name,
    version: f.pkg.version,
    integrity: f.pkg.integrity,
  };
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
        packages: [pkg],
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
  return {
    command,
    archive: f.files['package.tgz']!,
    files: Object.entries(f.files).map(([path, bytes]) => ({
      path,
      content: bytes.toString('base64'),
    })),
  };
}

function slowDownload() {
  let signal: AbortSignal | undefined;
  let finish: (bytes: Buffer) => void = () => {};
  download.mockImplementation(
    (_pkg: unknown, current: AbortSignal) =>
      new Promise<Buffer>((resolve, reject) => {
        signal = current;
        const aborted = () => reject(new Error('download aborted'));
        current.addEventListener('abort', aborted, { once: true });
        finish = (bytes) => {
          current.removeEventListener('abort', aborted);
          resolve(bytes);
        };
      }),
  );
  return {
    get signal() {
      return signal;
    },
    finish: (bytes: Buffer) => finish(bytes),
  };
}

it.each(['false', 'error'])(
  'revokes an already pending download when a live authority check returns %s',
  async (mode) => {
    const f = fixture();
    const slow = slowDownload();
    let allowed = true;
    const maintainLease = vi.fn(async () => {
      if (!allowed && mode === 'error')
        throw new Error('heartbeat unavailable');
      return allowed;
    });
    const pending = prepareDependencyArchives(f.command, f.files, {
      signal: new AbortController().signal,
      maintainLease,
    });
    const failed = expect(pending).rejects.toMatchObject({
      code: 'EXECUTION_REVOKED',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(download).toHaveBeenCalledTimes(1);
    allowed = false;
    await vi.advanceTimersByTimeAsync(1000);
    await failed;
    expect(slow.signal?.aborted).toBe(true);
    const calls = maintainLease.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(maintainLease).toHaveBeenCalledTimes(calls);
  },
);

it('does not overlap heartbeat requests and cancels without waiting for a stalled heartbeat', async () => {
  const f = fixture();
  const slow = slowDownload();
  let stall = false;
  let release: () => void = () => {};
  const maintainLease = vi.fn(async () => {
    if (stall)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return true;
  });
  const abort = new AbortController();
  const pending = prepareDependencyArchives(f.command, f.files, {
    signal: abort.signal,
    maintainLease,
  });
  const failed = expect(pending).rejects.toMatchObject({
    code: 'EXECUTION_REVOKED',
  });
  await vi.advanceTimersByTimeAsync(0);
  stall = true;
  const before = maintainLease.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(maintainLease).toHaveBeenCalledTimes(before + 1);
  abort.abort();
  await failed;
  expect(slow.signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  release();
  await vi.advanceTimersByTimeAsync(0);
});

it('rechecks authority after a successful download before returning any installable archives', async () => {
  const f = fixture();
  const slow = slowDownload();
  let allowed = true;
  const pending = prepareDependencyArchives(f.command, f.files, {
    signal: new AbortController().signal,
    maintainLease: async () => allowed,
  });
  const failed = expect(pending).rejects.toMatchObject({
    code: 'EXECUTION_REVOKED',
  });
  await vi.advanceTimersByTimeAsync(0);
  allowed = false;
  slow.finish(f.archive);
  await failed;
});

it('returns verified archives only after the final live check and clears its timer', async () => {
  const f = fixture();
  const slow = slowDownload();
  const maintainLease = vi.fn(async () => true);
  const pending = prepareDependencyArchives(f.command, f.files, {
    signal: new AbortController().signal,
    maintainLease,
  });
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(1000);
  const before = maintainLease.mock.calls.length;
  slow.finish(f.archive);
  expect(await pending).toEqual([f.archive.toString('base64')]);
  expect(maintainLease.mock.calls.length).toBeGreaterThan(before);
});

it('normalizes cancellation before preparation and while the initial authority check is pending', async () => {
  const f = fixture();
  const abort = new AbortController();
  abort.abort();
  await expect(
    prepareDependencyArchives(f.command, f.files, {
      signal: abort.signal,
    }),
  ).rejects.toMatchObject({ code: 'EXECUTION_REVOKED' });
  const later = new AbortController();
  const pending = prepareDependencyArchives(f.command, f.files, {
    signal: later.signal,
    maintainLease: () => new Promise(() => {}),
  });
  const failed = expect(pending).rejects.toMatchObject({
    code: 'EXECUTION_REVOKED',
  });
  later.abort();
  await failed;
  expect(download).not.toHaveBeenCalled();
});

it('clears its timer on integrity failure without claiming installation succeeded', async () => {
  const f = fixture();
  download.mockResolvedValue(Buffer.from('wrong archive'));
  await expect(
    prepareDependencyArchives(f.command, f.files, {
      signal: new AbortController().signal,
      maintainLease: async () => true,
    }),
  ).rejects.toMatchObject({ code: 'DEPENDENCY_INTEGRITY_MISMATCH' });
});
