import { lstat, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSea } from 'node:sea';
import { randomUUID } from 'node:crypto';
import {
  readCredentialRecordFile,
  writeCredentialRecordFile,
} from './credential-files.js';

export async function resolveLocalBrowserLauncher(): Promise<string> {
  if (process.platform !== 'darwin') throw Error('LOCAL_BROWSER_UNAVAILABLE');
  const base = dirname(process.execPath);
  const path = isSea()
    ? join(
        base.endsWith('/Contents/Resources') ? join(base, '../MacOS') : base,
        'RiceBrowserLauncher',
      )
    : fileURLToPath(new URL('../.local/RiceBrowserLauncher', import.meta.url));
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o022) !== 0 ||
    (stat.mode & 0o111) === 0 ||
    (stat.uid !== 0 && stat.uid !== process.getuid?.()) ||
    (await realpath(path)) !== path
  )
    throw Error('LOCAL_BROWSER_UNAVAILABLE');
  return path;
}

/** This is a local expiry mirror, never an authority or renewable offline lease.
 * The fixed native helper owns the actual Chrome process and survives Node EOF. */
export async function startLocalBrowserSupervisor(input: {
  directory: string;
  proxyPort: number;
  assertAlive: () => Promise<void>;
  expiresAt: () => number;
}) {
  const nonce = randomUUID();
  let stopped = false;
  let pending = Promise.resolve();
  const write = (stop: boolean) => {
    const task = pending.then(async () => {
      if (!stop) {
        if (stopped) return;
        await input.assertAlive();
      }
      const expiry = input.expiresAt();
      if (
        !stop &&
        (!Number.isFinite(expiry) ||
          expiry <= Date.now() ||
          expiry > Date.now() + 5000)
      )
        throw Error('LOCAL_BROWSER_LEASE_LOST');
      await writeCredentialRecordFile(
        input.directory,
        'lease.json',
        JSON.stringify({
          version: 1,
          nonce,
          parentPid: process.pid,
          proxyPort: input.proxyPort,
          stop,
          expiresAt: expiry,
        }),
      );
    });
    pending = task.catch(() => undefined);
    return task;
  };
  await write(false);
  const timer = setInterval(() => {
    void write(false).catch(() => {
      stopped = true;
      clearInterval(timer);
      void write(true).catch(() => undefined);
    });
  }, 400);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await write(true);
    },
    async confirmed(): Promise<boolean> {
      const text = await readCredentialRecordFile(
        input.directory,
        'process.json',
        { maxBytes: 4096 },
      );
      if (!text) return false;
      const value = JSON.parse(text);
      if (
        value.version !== 1 ||
        value.nonce !== nonce ||
        value.parentPid !== process.pid ||
        value.stopped !== true ||
        !Number.isSafeInteger(value.childPid) ||
        value.childPid < 2
      )
        return false;
      try {
        process.kill(value.childPid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    },
  };
}
