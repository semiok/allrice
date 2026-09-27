import { describe, it, expect } from 'vitest';
import type { OperationsInventory } from '@allrice/contracts';
import { operationsFacts } from './operations-resources';

const worker: OperationsInventory['workers'][number] = {
  workerId: 'b520db13-8cf1-4f07-8e5f-8271c5d3b3e3',
  hostname: 'test-host',
  platform: 'linux',
  observedAt: '2026-09-27T12:00:00Z',
  online: true,
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
  pressure: {
    jobs: { active: 20, queued: 0, longest_wait_ms: 0 },
    resources: { waiting: 17, executing: 3 },
    blocked: [],
  },
};
const inventory = (workers: (typeof worker)[]) => ({
  checkedAt: worker.observedAt,
  workers,
});
describe('admin operations facts', () => {
  it('counts a shared VM once and takes one global queue snapshot', () => {
    const facts = operationsFacts(
      inventory([worker, { ...worker, workerId: 'second-worker' }]),
    );
    expect(facts.nodes).toHaveLength(1);
    expect(facts.nodes[0]!.slots).toBe(3);
    expect(facts.pressure!.resources.waiting).toBe(17);
  });
  it('never substitutes zero or stale capacity when reports are missing, offline or probes fail', () => {
    for (const value of [
      null,
      inventory([]),
      inventory([{ ...worker, online: false }]),
      inventory([
        {
          ...worker,
          sandbox: null,
          sandboxStatus: 'unavailable',
          pressure: null,
        },
      ]),
    ]) {
      const facts = operationsFacts(value);
      expect(facts.nodes).toEqual([]);
      expect(facts.pressure).toBeNull();
    }
  });
});
