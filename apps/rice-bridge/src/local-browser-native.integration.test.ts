import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, lstat, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
describe.skipIf(process.env.ALLRICE_TEST_LOCAL_BROWSER_NATIVE !== '1')(
  'P22 actual installed native Chrome, isolated synthetic profile',
  () => {
    it.each([
      'graceful',
      'crash',
      'lease-expiry',
      'helper-quit',
      'lease-file-invalid',
    ] as const)(
      'creates a pipe-only fresh context and closes it after %s parent exit',
      async (mode) => {
        const root = await mkdtemp(join(tmpdir(), 'allrice-p22-native-'));
        const worker = fileURLToPath(
          new URL('../test/local-browser-native-worker.ts', import.meta.url),
        );
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', worker, root],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, TMPDIR: root },
          },
        );
        const exited = once(child, 'exit');
        let output = '',
          error = '';
        child.stdout.on('data', (bytes) => {
          output += bytes.toString();
        });
        child.stderr.on('data', (bytes) => {
          error += bytes.toString();
        });
        let children: Array<{
          pid: number;
          helperPid: number;
          userDataDir: string;
          directory: string;
          nonce: string;
          descendants?: Array<{ pid: number; pgid: number }>;
        }> = [];
        try {
          const deadline = Date.now() + 20000;
          while (
            !output.includes('\n') &&
            child.exitCode === null &&
            Date.now() < deadline
          )
            await sleep(25);
          if (!output.includes('\n'))
            throw Error(
              `Native fixture failed to start (${child.exitCode ?? 'timeout'}): ${error.slice(0, 1000)}`,
            );
          const ready = JSON.parse(output.split('\n')[0]!);
          children = ready.children;
          expect(ready).toMatchObject({
            ready: true,
            observationUrl: 'about:blank',
          });
          expect(ready.bytes).toBeGreaterThan(100);
          expect(children).toHaveLength(1);
          for (const owned of children) {
            expect(owned.pid).toBeGreaterThan(1);
            expect(
              owned.userDataDir.startsWith(root + '/allrice-browser-'),
            ).toBe(true);
            expect(owned.userDataDir.endsWith('/profile')).toBe(true);
            expect((await lstat(owned.userDataDir)).uid).toBe(
              process.getuid?.(),
            );
            expect(owned.descendants?.length).toBeGreaterThan(0);
            expect(
              owned.descendants?.every(({ pgid }) => pgid === owned.pid),
            ).toBe(true);
          }
          if (mode === 'crash') child.kill('SIGKILL');
          else if (mode === 'lease-expiry') child.stdin.write('expire\n');
          else if (mode === 'helper-quit')
            process.kill(children[0]!.helperPid, 'SIGTERM');
          else if (mode === 'lease-file-invalid')
            await chmod(join(children[0]!.directory, 'lease.json'), 0o644);
          else child.stdin.write('close\n');
          if (mode === 'crash' || mode === 'graceful') await exited;
          if (mode === 'graceful') expect(child.exitCode).toBe(0);
          const stopDeadline = Date.now() + 7000;
          while (
            children.some(({ pid }) => exists(pid)) &&
            Date.now() < stopDeadline
          )
            await sleep(25);
          expect(children.filter(({ pid }) => exists(pid))).toEqual([]);
          expect(
            children
              .flatMap((owned) => owned.descendants ?? [])
              .filter(({ pid }) => exists(pid)),
          ).toEqual([]);
          if (mode !== 'graceful') {
            for (const owned of children) {
              let status;
              const deadline = Date.now() + 2500;
              do {
                status = JSON.parse(
                  await readFile(join(owned.directory, 'process.json'), 'utf8'),
                );
                if (!status.stopped) await sleep(25);
              } while (!status.stopped && Date.now() < deadline);
              expect(status).toMatchObject({
                childPid: owned.pid,
                parentPid: child.pid,
                nonce: owned.nonce,
                stopped: true,
              });
            }
          }
        } finally {
          if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGKILL');
          await exited.catch(() => undefined);
          // Startup may fail before the worker emits its receipt. Inspect only
          // this test's exact random root, never global Chrome process lists.
          if (!children.length) {
            for (const name of await readdir(root)) {
              if (!name.startsWith('allrice-browser-')) continue;
              const directory = join(root, name);
              const raw = await readFile(
                join(directory, 'process.json'),
                'utf8',
              ).catch(() => null);
              if (!raw) continue;
              const record = JSON.parse(raw);
              if (
                record.parentPid === child.pid &&
                Number.isSafeInteger(record.childPid) &&
                record.childPid > 1
              )
                children.push({
                  pid: record.childPid,
                  helperPid: record.helperPid,
                  nonce: record.nonce,
                  directory,
                  userDataDir: join(directory, 'profile'),
                });
            }
          }
          for (const owned of children) {
            if (exists(owned.pid)) {
              const { stdout } = await promisify(execFile)(
                '/bin/ps',
                ['-p', String(owned.pid), '-o', 'command='],
                { timeout: 2000 },
              );
              if (
                stdout.includes(`--user-data-dir=${owned.userDataDir}`) &&
                stdout.includes('--remote-debugging-pipe')
              )
                process.kill(-owned.pid, 'SIGKILL');
              for (let i = 0; i < 100 && exists(owned.pid); i++)
                await sleep(25);
            }
            if (
              !exists(owned.pid) &&
              owned.userDataDir.startsWith(root + '/allrice-browser-')
            ) {
              const stat = await lstat(owned.userDataDir).catch(() => null);
              if (
                stat?.isDirectory() &&
                !stat.isSymbolicLink() &&
                stat.uid === process.getuid?.()
              )
                await rm(owned.userDataDir, { recursive: true });
            }
          }
          if (children.every(({ pid }) => !exists(pid)))
            await rm(root, { recursive: true, force: true });
        }
        expect(children.filter(({ pid }) => exists(pid))).toEqual([]);
      },
      35000,
    );
  },
);
