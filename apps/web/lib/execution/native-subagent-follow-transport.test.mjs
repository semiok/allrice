/* global AbortController */
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { requestNativeSubagentFollow } from './native-run-diagnostics.ts';
const teardown = [];
afterEach(async () => {
  for (const fn of teardown.splice(0).reverse()) await fn();
  vi.unstubAllEnvs();
});
async function upstream(status = 200, type = 'text/event-stream') {
  let closed = false;
  const server = createServer((req, res) => {
    req.resume();
    res.on('close', () => {
      closed = true;
    });
    res.writeHead(status, { 'content-type': type });
    res.write(
      type === 'text/event-stream' ? ': open\n\n' : '{"error":"unavailable"}',
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  vi.stubEnv(
    'ALLRICE_WORKER_INTERNAL_URL',
    `http://127.0.0.1:${server.address().port}`,
  );
  const abort = new AbortController();
  teardown.push(async () => {
    abort.abort();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const input = {
    token: 'TEST_BEARER_1234567890',
    context: { organizationId: '00000000-0000-4000-8000-000000000001' },
    workspaceId: '00000000-0000-4000-8000-000000000002',
    sessionId: '00000000-0000-4000-8000-000000000003',
    signal: abort.signal,
  };
  return { input, closed: () => closed };
}
it.each([
  [503, 'application/json'],
  [200, 'application/json'],
])(
  'blind: rejected upstream %i / %s must release its body/socket',
  async (status, type) => {
    const f = await upstream(status, type);
    await expect(requestNativeSubagentFollow(f.input)).rejects.toMatchObject({
      status: 503,
    });
    await delay(300);
    expect(f.closed()).toBe(true);
  },
);
it('blind: cancelling a successful Web reader releases the real upstream socket', async () => {
  const f = await upstream();
  const response = await requestNativeSubagentFollow(f.input);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  reader.releaseLock();
  await delay(100);
  expect(f.closed()).toBe(true);
});
