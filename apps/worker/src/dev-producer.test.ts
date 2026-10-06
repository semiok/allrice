import { describe, expect, it, vi } from 'vitest';
import {
  DevMaintenanceError,
  type DevProducerContext,
} from '@allrice/database';
import { workerProducerRunner } from './dev-producer.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const context: DevProducerContext = { child: (body) => body(context) };

describe('Worker durable admission during shutdown', () => {
  it('does not start authorization or another producer when shutdown began during admission', async () => {
    const admission = deferred(),
      business = vi.fn(async () => undefined);
    let stopping = false;
    const run = workerProducerRunner(
      {
        async run(_producer, body) {
          await admission.promise;
          return body(context);
        },
      },
      () => stopping,
    );
    const authorizationTask = run('provider_authorization', business);
    expect(business).not.toHaveBeenCalled();
    // This is the same ordering as closing a broker while its root is pending.
    stopping = true;
    admission.resolve();
    await authorizationTask;
    expect(business).not.toHaveBeenCalled();
  });
  it('keeps an already admitted business task awaited through shutdown', async () => {
    const held = deferred();
    let stopping = false,
      settled = false;
    const run = workerProducerRunner(
      {
        async run(_producer, body) {
          return body(context);
        },
      },
      () => stopping,
    );
    const task = run('automation', async () => {
      await held.promise;
    }).then(() => {
      settled = true;
    });
    stopping = true;
    await Promise.resolve();
    expect(settled).toBe(false);
    held.resolve();
    await task;
    expect(settled).toBe(true);
  });
  it('ignores only a known pre-insert maintenance refusal and preserves other failures', async () => {
    const body = vi.fn(async () => undefined);
    const refused = workerProducerRunner(
      {
        async run() {
          throw new DevMaintenanceError('dev_maintenance_requested');
        },
      },
      () => false,
    );
    await refused('ordinary_consumer', body);
    expect(body).not.toHaveBeenCalled();
    const failed = workerProducerRunner(
      {
        async run() {
          throw new Error('commit result unknown');
        },
      },
      () => false,
    );
    await expect(failed('ordinary_consumer', body)).rejects.toThrow(
      'commit result unknown',
    );
    expect(body).not.toHaveBeenCalled();
  });
});
