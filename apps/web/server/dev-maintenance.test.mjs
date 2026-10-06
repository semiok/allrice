import { createServer, request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { setImmediate } from 'node:timers';
import { afterEach, describe, expect, it } from 'vitest';
import { DevProducerLifecycle } from '../../../packages/database/src/dev-producer-lifecycle.ts';
import { DevMaintenanceError } from '../../../packages/database/src/dev-maintenance.ts';
import { createDevRequestHandler } from './dev-maintenance.mjs';

const servers = [];
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function start(handle) {
  let closed = false,
    starts = 0,
    finished = 0;
  const identity = {
    service: 'web',
    mode: 'production',
    bootId: randomUUID(),
    manifestDigest: 'sha256:' + 'a'.repeat(64),
    pid: process.pid,
  };
  const lifecycle = new DevProducerLifecycle(true, 'web', identity, {
    async start(input) {
      starts++;
      if (closed) throw new DevMaintenanceError('dev_maintenance_requested');
      return { id: input.id, instanceBootId: identity.bootId, epoch: 0 };
    },
    async finish() {
      finished++;
    },
  });
  const server = createServer(createDevRequestHandler(lifecycle, handle));
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    lifecycle,
    url: 'http://127.0.0.1:' + server.address().port,
    closeAdmission() {
      closed = true;
    },
    counts: () => ({ starts, finished }),
  };
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
describe('Actual HTTP request lifetime under a maintenance gate', () => {
  it('response finish does not finish a still-writing handler, and productive GET is refused before dispatch', async () => {
    const held = deferred(),
      done = deferred();
    let writes = 0;
    const s = await start(async (_, res) => {
      res.end('accepted');
      await held.promise;
      writes++;
      done.resolve();
    });
    const first = await globalThis.fetch(s.url + '/productive-get');
    expect(await first.text()).toBe('accepted');
    expect(s.counts().finished).toBe(0);
    expect(s.lifecycle.snapshot().activeRoots).toBe(1);
    s.closeAdmission();
    expect((await globalThis.fetch(s.url + '/productive-get')).status).toBe(
      503,
    );
    expect(writes).toBe(0);
    held.resolve();
    await done.promise;
    for (let n = 0; n < 50 && s.counts().finished === 0; n++)
      await new Promise((r) => setImmediate(r));
    expect(writes).toBe(1);
    expect(s.counts().finished).toBe(1);
  });
  it('client disconnect does not release work before its actual handler completes', async () => {
    const entered = deferred(),
      held = deferred(),
      done = deferred();
    const s = await start(async (_, res) => {
      entered.resolve();
      await held.promise;
      res.end('late');
      done.resolve();
    });
    const request = httpRequest(s.url + '/work');
    request.on('error', () => {});
    request.end();
    await entered.promise;
    request.destroy();
    await new Promise((r) => setImmediate(r));
    expect(s.counts().finished).toBe(0);
    expect(s.lifecycle.snapshot().activeRoots).toBe(1);
    held.resolve();
    await done.promise;
    for (let n = 0; n < 50 && s.counts().finished === 0; n++)
      await new Promise((r) => setImmediate(r));
    expect(s.counts().finished).toBe(1);
  });
  it('only exact read-only health methods bypass admission, not arbitrary GET or health POST', async () => {
    let handled = 0;
    const s = await start(async (_, res) => {
      handled++;
      res.end('health');
    });
    s.closeAdmission();
    expect((await globalThis.fetch(s.url + '/api/health/ready')).status).toBe(
      200,
    );
    expect(
      (await globalThis.fetch(s.url + '/api/health/ready', { method: 'POST' }))
        .status,
    ).toBe(503);
    expect(
      (await globalThis.fetch(s.url + '/api/health/ready/extra')).status,
    ).toBe(503);
    expect(handled).toBe(1);
    expect(s.counts()).toEqual({ starts: 2, finished: 0 });
  });
});
