import type * as ChildProcess from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';

const ports = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: ports.run,
  }),
}));
import { KeychainUnavailableError, readKeychainToken } from './keychain.js';

const device = '00000000-0000-4000-8000-000000000089';
const expectedOptions = {
  encoding: 'utf8',
  timeout: 5000,
  maxBuffer: 65536,
  killSignal: 'SIGKILL',
};

// This suite tests real execFile lifecycle with a Node fixture, not Keychain.
// The product has no execution override; only this mocked import swaps the
// already-checked exact security request for this test's own fixed child.
it.each([
  ['hang', 'timed-out'],
  ['overflow', 'unavailable'],
] as const)(
  'reaps the real %s child before reporting %s, without invoking security',
  async (mode, reason) => {
    const root = await mkdtemp(join(tmpdir(), 'allrice-keychain-child-'));
    const fixture = join(root, 'fixture.mjs');
    const receipt = join(root, 'started.json');
    let child: ChildProcess.ChildProcess | undefined;
    ports.run.mockReset();
    try {
      await writeFile(
        fixture,
        `import { writeFileSync } from 'node:fs';
const [receipt, mode] = process.argv.slice(2);
writeFileSync(receipt, JSON.stringify({ pid: process.pid, mode }), { mode: 0o600 });
if (mode === 'overflow') {
  setInterval(() => process.stdout.write('x'.repeat(8192)), 1);
} else {
  setInterval(() => {}, 1000);
}
`,
        { mode: 0o600 },
      );
      const actual =
        await vi.importActual<typeof ChildProcess>('node:child_process');
      const actualRun = promisify(actual.execFile);
      ports.run.mockImplementation((file, args, options) => {
        expect(file).toBe('/usr/bin/security');
        expect(args).toEqual([
          'find-generic-password',
          '-s',
          'ai.traditionow.allrice.rice-bridge',
          '-a',
          device,
          '-w',
        ]);
        expect(options).toEqual(expectedOptions);
        // Retain every product bound and signal; only executable/fixture args
        // differ. No model credentials or real Keychain arguments reach Node.
        const execution = actualRun(
          process.execPath,
          [fixture, receipt, mode],
          options,
        );
        child = execution.child;
        return execution;
      });
      const startedAt = performance.now();
      const failure = await readKeychainToken(device).catch(
        (error: unknown) => error,
      );
      const elapsed = performance.now() - startedAt;
      // No intervening await: check process liveness as soon as the adapter
      // returns, before even reading its already-written startup receipt.
      const pid = child?.pid;
      if (pid === undefined) throw Error('FIXTURE_CHILD_NOT_STARTED');
      let probeError: unknown;
      try {
        process.kill(pid, 0);
      } catch (error) {
        probeError = error;
      }
      expect(probeError).toMatchObject({ code: 'ESRCH' });
      expect(failure).toBeInstanceOf(KeychainUnavailableError);
      expect(failure).toMatchObject({
        message: 'KEYCHAIN_UNAVAILABLE',
        reason,
      });
      expect(failure).not.toHaveProperty('cause');
      expect(failure).not.toHaveProperty('stderr');
      expect(String(failure)).not.toContain(root);
      expect(ports.run).toHaveBeenCalledTimes(1);
      const started = JSON.parse(await readFile(receipt, 'utf8')) as {
        pid: number;
        mode: string;
      };
      expect(started).toEqual({ pid: child?.pid, mode });
      expect(Number.isInteger(started.pid) && started.pid > 0).toBe(true);
      expect(child?.signalCode).toBe('SIGKILL');
      // The configured timeout is exactly 5 s; allow scheduler/child teardown
      // overhead instead of making an impossible <=5000 ms wall-clock claim.
      expect(elapsed).toBeLessThan(10_000);
      if (mode === 'hang') expect(elapsed).toBeGreaterThanOrEqual(4500);
    } finally {
      if (
        child?.pid !== undefined &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        const closed = once(child, 'close');
        child.kill('SIGKILL');
        await closed;
      }
      ports.run.mockReset();
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
