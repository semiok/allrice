import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import type { WorkerOperations } from '@allrice/contracts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import {
  readOperationsInventory,
  recordWorkerOperations,
  removeWorkerOperations,
} from './operations-resources.ts';
import { executionPressureSnapshot } from './execution-diagnostics.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
suite('operations resource inventory', () => {
  it('uses real database freshness, tolerates malformed reports and retires stale workers on restart', async () => {
    const f = await createAssistantFixtureDatabase();
    try {
      const report: WorkerOperations = {
        workerId: randomUUID(),
        hostname: 'test-host',
        platform: 'linux',
        capacity: {
          mode: 'auto',
          concurrency: 20,
          cpus: 8,
          memoryBytes: 16 * 1024 ** 3,
        },
        availableMemoryBytes: 1024 ** 3,
        rssBytes: 256 * 1024 ** 2,
        sandbox: {
          backendId: 'shared-vm',
          cpus: 3,
          memoryBytes: 4 * 1024 ** 3,
          availableBytes: 2 * 1024 ** 3,
          reservedBytes: 800 * 1024 ** 2,
          servicesBytes: 768 * 1024 ** 2,
          slots: 3,
          running: 2,
        },
        sandboxStatus: 'ready',
        pressure: await executionPressureSnapshot(f.db),
      };
      await recordWorkerOperations(report, f.db);
      expect((await readOperationsInventory(f.db)).workers).toMatchObject([
        { online: true, sandbox: { slots: 3, running: 2 } },
      ]);
      await f.db`update allrice_runtime_metadata set updated_at=clock_timestamp()-interval '91 seconds' where key=${'worker-operations:' + report.workerId}`;
      expect((await readOperationsInventory(f.db)).workers[0]!.online).toBe(
        false,
      );
      const current = {
        ...report,
        workerId: randomUUID(),
        sandbox: null,
        sandboxStatus: 'unavailable' as const,
      };
      await recordWorkerOperations(current, f.db);
      await f.db`insert into allrice_runtime_metadata(key,value) values ('worker-operations:malformed','{}')`;
      expect((await readOperationsInventory(f.db)).workers).toMatchObject([
        { workerId: current.workerId, online: true, sandbox: null },
      ]);
      expect((await readOperationsInventory(f.db)).workers).toHaveLength(1);
      await removeWorkerOperations(current.workerId, f.db);
      expect((await readOperationsInventory(f.db)).workers).toMatchObject([
        { workerId: report.workerId, online: false },
      ]);
    } finally {
      await f.close();
    }
  }, 30000);
});
