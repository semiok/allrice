import { describe, expect, it, vi } from 'vitest';
import {
  closeWorkerResources,
  startWorkerShutdownTask,
  WorkerShutdownError,
} from './worker-shutdown.js';

const deferred = () => {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function plan() {
  const order: string[] = [];
  const step = (name: string) =>
    vi.fn(async () => {
      order.push(name);
    });
  return {
    order,
    input: {
      drainTasks: [],
      waitForProducerRoots: step('roots'),
      stopCloudProjects: step('cloud'),
      closeHarness: step('harness'),
      waitForInventory: step('inventory'),
      verifyRuntimeClosure: step('readback'),
      removeCapabilities: step('capabilities'),
      closeDatabase: step('database'),
    },
  };
}

describe('Worker shutdown ownership and dependency drain', () => {
  it('invokes every independent owner even when an earlier close throws synchronously', async () => {
    const p = plan(),
      later = vi.fn(),
      original = Error('auth close');
    const result = closeWorkerResources({
      ...p.input,
      drainTasks: [
        {
          name: 'auth',
          run() {
            throw original;
          },
        },
        { name: 'probe', run: later },
      ],
    });
    await expect(result).rejects.toMatchObject({
      code: 'WORKER_SHUTDOWN_UNCONFIRMED',
      errors: [original],
    });
    expect(later).toHaveBeenCalledOnce();
    expect(p.order).toEqual([
      'roots',
      'cloud',
      'harness',
      'inventory',
      'readback',
      'capabilities',
      'database',
    ]);
  });
  it('does not skip final closure readback or DB close on roots/cloud/pool failure', async () => {
    const p = plan();
    p.input.waitForProducerRoots.mockRejectedValueOnce(Error('roots'));
    p.input.stopCloudProjects.mockRejectedValueOnce(Error('cloud'));
    p.input.closeHarness.mockRejectedValueOnce(Error('pool'));
    const error = await closeWorkerResources(p.input).catch((value) => value);
    expect(error).toBeInstanceOf(WorkerShutdownError);
    expect(error.failures.map((f: { name: string }) => f.name)).toEqual([
      'producer_roots',
      'cloud_services',
      'harness',
    ]);
    expect(p.order).toEqual([
      'inventory',
      'readback',
      'capabilities',
      'database',
    ]);
  });
  it('waits for a slow second control after the first has rejected', async () => {
    const p = plan(),
      pending = deferred();
    const task = closeWorkerResources({
      ...p.input,
      drainTasks: [
        { name: 'once', run: () => Promise.reject(Error('once')) },
        { name: 'recurring', run: () => pending.promise },
      ],
    });
    void task.catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(p.order).toEqual([]);
    pending.resolve();
    await expect(task).rejects.toMatchObject({ failures: [{ name: 'once' }] });
    expect(p.input.closeDatabase).toHaveBeenCalledOnce();
  });
  it('waits for the current inventory write before final readback', async () => {
    const p = plan(),
      pending = deferred();
    p.input.waitForInventory.mockImplementation(() => pending.promise);
    const task = closeWorkerResources(p.input);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(p.input.verifyRuntimeClosure).not.toHaveBeenCalled();
    expect(p.input.closeDatabase).not.toHaveBeenCalled();
    pending.resolve();
    await task;
    expect(p.order).toEqual([
      'roots',
      'cloud',
      'harness',
      'readback',
      'capabilities',
      'database',
    ]);
  });
  it('retains readback, capability and DB failures without claiming success', async () => {
    const p = plan();
    p.input.verifyRuntimeClosure.mockRejectedValueOnce(undefined);
    p.input.removeCapabilities.mockRejectedValueOnce(null);
    p.input.closeDatabase.mockRejectedValueOnce(false);
    await expect(closeWorkerResources(p.input)).rejects.toMatchObject({
      errors: [undefined, null, false],
    });
  });
  it('does not swallow a falsey independent rejection', async () => {
    const p = plan();
    await expect(
      closeWorkerResources({
        ...p.input,
        drainTasks: [{ name: 'owner', run: () => Promise.reject(0) }],
      }),
    ).rejects.toMatchObject({ errors: [0] });
  });
  it('begins the fence synchronously and preserves its exact promise outcome', async () => {
    const start = vi.fn(() => {
      throw Error('fence');
    });
    const task = startWorkerShutdownTask(start);
    expect(start).toHaveBeenCalledOnce();
    await expect(task).rejects.toThrow('fence');
  });
  it('returns only after the last DB cleanup has settled', async () => {
    const p = plan(),
      pending = deferred();
    p.input.closeDatabase.mockImplementation(() => pending.promise);
    let settled = false;
    const task = closeWorkerResources(p.input).then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    pending.resolve();
    await task;
    expect(settled).toBe(true);
  });
});
