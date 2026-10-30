// Controlled silent transport: actual RPC timeout and pool aggregation, not a stalled real Host.
import { expect, it, vi } from 'vitest';
import { DshRuntimePool } from '../../src/harness/dsh/runtime-pool.ts';
import { DshProtocolClient } from '../../src/harness/dsh-protocol-client.ts';

it('a silent question read becomes unknown within the existing projection budget', async () => {
  vi.stubEnv('ALLRICE_DSH_REQUEST_TIMEOUT_MS', '300000');
  vi.useFakeTimers();
  try {
    const client = Object.create(DshProtocolClient.prototype);
    Object.assign(client, {
      requestId: 0,
      pending: new Map(),
      launch: { requestTimeoutMs: 300000 },
      child: { stdin: { write: (_frame, callback) => callback() } },
    });
    client.processState = () => ({ state: 'running' });
    const pool = new DshRuntimePool();
    Reflect.get(pool, 'ownedRuntimes').add({
      client,
      id: '00000000-0000-4000-8000-000000000001',
      sessionId: 'dsh-silent',
      executionObservation: {
        runId: 'run',
        jobId: 'job',
        attempt: 1,
        generation: 1,
      },
    });
    let completed = false;
    const result = pool.questionSnapshots().then((value) => {
      completed = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(10000);
    const completedWithinReadBudget = completed;
    // Drain the old execution budget too, so the regression fails cleanly.
    await vi.advanceTimersByTimeAsync(290000);
    expect((await result)[0].foreground).toBeNull();
    expect(client.pending.size).toBe(0);
    expect(completedWithinReadBudget).toBe(true);
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});
