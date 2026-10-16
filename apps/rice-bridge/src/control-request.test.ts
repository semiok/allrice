import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  SandboxControlFailureSchema,
  resolveSandboxExecutionPolicy,
  sandboxExecutionBudgetSpec,
  startSandboxExecutionBudget,
  renewSandboxExecutionBudget,
  type SandboxExecutionRenewal,
} from '@allrice/contracts';
import { SandboxExecutionBudgetController } from '@allrice/project-runtime';
import {
  BridgeControlError,
  BridgeControlRequests,
} from './control-request.js';
import { bridgeRequest, type BridgeRequestInput } from './client.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
) {
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw Error('missing test address');
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${address.port}`;
}
function request(server: string, action = 'budget'): BridgeRequestInput {
  return {
    server,
    path: `/api/v1/bridge/device/operations/${randomUUID()}/${action}`,
    method: 'POST',
    body: { contractVersion: 1 },
    maximumResponseBytes: 32768,
    timeoutMs: 1000,
  };
}

it('reuses one accepted renewal after its HTTP acknowledgement is lost', async () => {
  const now = Date.now();
  const spec = sandboxExecutionBudgetSpec(
    { version: 1, kind: 'compute' },
    resolveSandboxExecutionPolicy([]),
  );
  const initial = startSandboxExecutionBudget(spec, now - 45000, now + 555000);
  let authority = initial;
  const bodies: string[] = [];
  const server = await serve(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(Buffer.concat(chunks).toString());
    const body = JSON.parse(bodies.at(-1)!) as {
      renewal: SandboxExecutionRenewal;
    };
    authority = renewSandboxExecutionBudget(
      authority,
      body.renewal,
      Date.now(),
      initial.hardDeadlineAt,
    );
    if (bodies.length === 1) {
      res.destroy();
      return;
    }
    res.end(JSON.stringify(authority));
  });
  const control = new BridgeControlRequests();
  const budget = new SandboxExecutionBudgetController(
    initial,
    spec,
    (renewal) =>
      control.send('budget', { ...request(server), body: { renewal } }),
  );
  const progress = vi.fn(async () => ({
    cpuNanos: 2000000,
    readBytes: 16,
    writtenBytes: 0,
  }));
  await budget.renew(progress);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(bodies[1]);
  expect(progress).toHaveBeenCalledOnce();
  expect(budget.state.sequence).toBe(1);
  expect(budget.state.renewals).toHaveLength(1);
  expect(budget.state.deadlineAt).toBe(initial.deadlineAt + 60000);
  expect(budget.state.startedAt).toBe(initial.startedAt);
  expect(budget.state.hardDeadlineAt).toBe(initial.hardDeadlineAt);
  expect(control.failure).toBeUndefined();
});

it('bounds persistent disconnection to two attempts with safe structured diagnostics', async () => {
  const bodies: string[] = [];
  const server = await serve(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(Buffer.concat(chunks).toString());
    res.destroy();
  });
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const control = new BridgeControlRequests();
  await expect(
    control.send('heartbeat', {
      ...request(server, 'heartbeat'),
      token: 'test-secret-token',
      body: { leaseToken: 'test-secret-lease' },
    }),
  ).rejects.toBeInstanceOf(BridgeControlError);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(bodies[1]);
  expect(control.failure).toMatchObject({
    stage: 'heartbeat',
    kind: 'transport',
    attempts: 2,
  });
  expect(JSON.stringify(log.mock.calls)).not.toMatch(
    /test-secret|127\.0\.0\.1|Bearer/,
  );
  expect(
    SandboxControlFailureSchema.safeParse({
      ...control.failure,
      message: 'secret',
    }).success,
  ).toBe(false);
  expect(
    control.withFailure({ reason: 'lease_lost', exitCode: 137 }),
  ).toHaveProperty('controlFailure', control.failure);
  expect(
    control.withFailure({ reason: 'exited', exitCode: 0 }),
  ).not.toHaveProperty('controlFailure');
});

it.each([403, 409, 503])('does not retry HTTP %i rejection', async (status) => {
  let calls = 0;
  const server = await serve((_req, res) => {
    calls++;
    res.statusCode = status;
    res.end(JSON.stringify({ error: { message: 'private-server-error' } }));
  });
  const control = new BridgeControlRequests();
  await expect(control.send('budget', request(server))).rejects.toBeInstanceOf(
    BridgeControlError,
  );
  expect(calls).toBe(1);
  expect(control.failure).toMatchObject({
    stage: 'budget',
    kind: 'rejected',
    httpStatus: status,
    attempts: 1,
  });
  expect(JSON.stringify(control.failure)).not.toContain('private-server-error');
});

it('does not retry a malformed acknowledgement', async () => {
  let calls = 0;
  const server = await serve((_req, res) => {
    calls++;
    res.end('not-json');
  });
  const control = new BridgeControlRequests();
  await expect(control.send('budget', request(server))).rejects.toBeInstanceOf(
    BridgeControlError,
  );
  expect(calls).toBe(1);
  expect(control.failure).toMatchObject({
    stage: 'budget',
    kind: 'invalid_response',
    attempts: 1,
  });
});

it('keeps both attempts and a stalled response body inside one deadline', async () => {
  const seen: number[] = [];
  let calls = 0;
  const server = await serve((_req, res) => {
    if (++calls === 1) {
      setTimeout(() => res.destroy(), 50);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{'); // Headers arrive, body never finishes.
  });
  const send: typeof bridgeRequest = async (input) => {
    seen.push(input.timeoutMs!);
    return bridgeRequest(input);
  };
  const control = new BridgeControlRequests(send);
  const start = performance.now();
  await expect(
    control.send('budget', { ...request(server), timeoutMs: 300 }),
  ).rejects.toBeInstanceOf(BridgeControlError);
  expect(calls).toBe(2);
  expect(seen[1]).toBeLessThan(seen[0]! - 30);
  expect(performance.now() - start).toBeLessThan(700);
  expect(control.failure).toMatchObject({
    stage: 'budget',
    kind: 'timeout',
    attempts: 2,
  });
});

it('cancels a pending request immediately without reconnecting or accepting a late reply', async () => {
  let resolve!: (value: object) => void;
  const send = vi.fn(
    () =>
      new Promise<object>((r) => {
        resolve = r;
      }),
  );
  const control = new BridgeControlRequests(send as typeof bridgeRequest);
  const abort = new AbortController();
  const pending = control.send('budget', {
    ...request('http://unused'),
    signal: abort.signal,
  });
  const rejected = expect(pending).rejects.toBeInstanceOf(BridgeControlError);
  abort.abort(Error('private cancellation reason'));
  await rejected;
  resolve({ unexpected: true });
  expect(send).toHaveBeenCalledOnce();
  expect(control.failure).toMatchObject({
    stage: 'budget',
    kind: 'canceled',
    attempts: 1,
  });
});

it.each(['start', 'next', 'receipts', 'budget?replay=1'])(
  'never sends a retried request to %s',
  async (action) => {
    const send = vi.fn();
    const control = new BridgeControlRequests(send);
    await expect(
      control.send('budget', request('http://unused', action)),
    ).rejects.toBeInstanceOf(BridgeControlError);
    expect(send).not.toHaveBeenCalled();
  },
);
