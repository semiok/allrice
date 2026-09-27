import { mkdir, stat, rename, appendFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { executionPressureSnapshot } from '@allrice/database';

/** Eight 5 MB segments per Worker, sampled every 30 seconds. Per-run events
 * remain in the existing DB audit history; these files capture server-wide
 * pressure, including periods when the DB is unavailable. */
export function startExecutionPressureLog(
  root: string,
  workerId: string,
  capacity: unknown,
) {
  let pending = false;
  const directory = join(root, 'diagnostics', workerId);
  const path = join(directory, 'pressure.jsonl');
  let lastRetention = 0;
  const sample = async () => {
    if (pending) return;
    pending = true;
    try {
      const started = Date.now();
      let snapshot: unknown;
      try {
        snapshot = await executionPressureSnapshot();
      } catch {
        snapshot = { error: 'database_unavailable' };
      }
      const record = {
        event: 'execution_pressure',
        at: new Date().toISOString(),
        workerId,
        capacity,
        availableMemoryBytes: process.availableMemory?.(),
        rssBytes: process.memoryUsage().rss,
        queryMs: Date.now() - started,
        snapshot,
      };
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (Date.now() - lastRetention > 3600_000) {
        lastRetention = Date.now();
        // A Worker UUID changes on restart. Retire only our own inactive log
        // directories, otherwise per-process rotation alone is unbounded.
        for (const entry of await readdir(join(root, 'diagnostics'), {
          withFileTypes: true,
        })) {
          if (
            !entry.isDirectory() ||
            entry.name === workerId ||
            !/^[a-f0-9-]{36}$/.test(entry.name)
          )
            continue;
          const old = join(root, 'diagnostics', entry.name);
          const latest = await stat(join(old, 'pressure.jsonl')).catch(
            () => null,
          );
          if (latest && Date.now() - latest.mtimeMs > 7 * 86400_000)
            await rm(old, { recursive: true });
        }
      }
      if (
        await stat(path).then(
          (s) => s.size >= 5_000_000,
          () => false,
        )
      ) {
        for (let n = 6; n >= 0; n--)
          await rename(
            n === 0 ? path : `${path}.${n}`,
            `${path}.${n + 1}`,
          ).catch(() => undefined);
      }
      await appendFile(path, JSON.stringify(record) + '\n', { mode: 0o600 });
    } catch {
      console.error('[MET162] execution pressure log unavailable');
    } finally {
      pending = false;
    }
  };
  void sample();
  const timer = setInterval(() => void sample(), 30_000);
  timer.unref();
  return () => clearInterval(timer);
}
