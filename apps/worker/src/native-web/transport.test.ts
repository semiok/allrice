import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { nativeWebTransport } from './transport.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(
    cleanup
      .splice(0)
      .reverse()
      .map((close) => close()),
  );
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
});
for (const accepted of [false, true])
  it(`close joins exact HTTP request ${accepted ? 'after accept' : 'before socket assignment'}`, async () => {
    // Transport-only close fixture; never a dummy DSH RPC/readiness server.
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const server = createServer(() => enter());
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const transport = nativeWebTransport(
      origin,
      new AbortController().signal,
      () => {},
    );
    cleanup.push(async () => {
      await transport.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    });
    let settled = false;
    const call = transport.fetch(new URL('/', origin), { method: 'GET' }).then(
      () => {
        settled = true;
        throw Error('fixture must not respond');
      },
      () => {
        settled = true;
      },
    );
    if (accepted) await entered;
    await transport.close();
    expect(settled).toBe(true);
    await call;
    await expect(
      transport.fetch(new URL('/', origin), { method: 'GET' }),
    ).rejects.toBeDefined();
  });
