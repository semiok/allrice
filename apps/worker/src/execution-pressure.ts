import { mkdir, stat, rename, appendFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import {
  ExecutionPressureSchema,
  runtimeFeatureEnabled,
  type WorkerOperations,
} from '@allrice/contracts';
import {
  executionPressureSnapshot,
  recordWorkerOperations,
  removeWorkerOperations,
} from '@allrice/database';
import { CloudRunnerBackend } from './cloud-runner/backend.js';
import type { detectWorkerCapacity } from './worker-capacity.js';

/** Eight 5 MB segments per Worker, sampled every 30 seconds. Per-run events
 * remain in the existing DB audit history; these files capture server-wide
 * pressure, including periods when the DB is unavailable. */
export function startExecutionPressureLog(
  root: string,
  workerId: string,
  capacity: ReturnType<typeof detectWorkerCapacity>,
) {
  let pending = false;
  let stopped = false;
  const directory = join(root, 'diagnostics', workerId);
  const path = join(directory, 'pressure.jsonl');
  let lastRetention = 0;
  const sample = async () => {
    if (pending || stopped) return;
    pending = true;
    try {
      const started = Date.now();
      let snapshot: unknown;
      try {
        snapshot = await executionPressureSnapshot();
      } catch {
        snapshot = { error: 'database_unavailable' };
      }
      let sandbox: WorkerOperations['sandbox'] = null;
      const enabled = runtimeFeatureEnabled('ALLRICE_CLOUD_RUNNER_ENABLED');
      if (enabled) {
        try {
          sandbox = await new CloudRunnerBackend().resources();
        } catch {
          /* Show unavailable, never zero usage. */
        }
      }
      const parsedPressure = ExecutionPressureSchema.safeParse(snapshot);
      const operations: WorkerOperations = {
        workerId,
        hostname: hostname(),
        platform: process.platform,
        capacity,
        availableMemoryBytes: Math.min(
          process.availableMemory?.() ?? capacity.availableBytes,
          capacity.memoryBytes,
        ),
        rssBytes: process.memoryUsage().rss,
        sandbox,
        sandboxStatus: !enabled
          ? 'disabled'
          : sandbox
            ? 'ready'
            : 'unavailable',
        pressure: parsedPressure.success ? parsedPressure.data : null,
      };
      // Diagnostics failure must never interrupt tenant execution or file logs.
      if (!stopped)
        await recordWorkerOperations(operations).catch(() => undefined);
      const record = {
        event: 'execution_pressure',
        at: new Date().toISOString(),
        ...operations,
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
  return () => {
    stopped = true;
    clearInterval(timer);
    void removeWorkerOperations(workerId).catch(() => undefined);
  };
}
