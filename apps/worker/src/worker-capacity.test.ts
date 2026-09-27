import { describe, it, expect } from 'vitest';
import { workerCapacity } from './worker-capacity.js';
const GiB = 1024 ** 3;
describe('automatic main-job capacity', () => {
  it('uses effective available memory and CPU independently of sandbox slots', () => {
    expect(
      workerCapacity({
        cpus: 8,
        memoryBytes: 16 * GiB,
        availableBytes: 6 * GiB,
      }).concurrency,
    ).toBe(24);
    expect(
      workerCapacity({ cpus: 2, memoryBytes: 2 * GiB, availableBytes: GiB })
        .concurrency,
    ).toBe(4);
    expect(
      workerCapacity({
        cpus: 32,
        memoryBytes: 64 * GiB,
        availableBytes: 50 * GiB,
      }).concurrency,
    ).toBe(32);
  });
  it('retains explicit deployment limits and rejects invalid overrides', () => {
    expect(
      workerCapacity({
        cpus: 8,
        memoryBytes: 16 * GiB,
        availableBytes: 6 * GiB,
        configured: '1',
      }),
    ).toEqual({ mode: 'configured', concurrency: 1 });
    for (const configured of ['0', '33', 'NaN', '2.5'])
      expect(() =>
        workerCapacity({
          cpus: 8,
          memoryBytes: 16 * GiB,
          availableBytes: 6 * GiB,
          configured,
        }),
      ).toThrow();
  });
});
