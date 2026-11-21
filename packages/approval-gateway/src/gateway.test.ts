import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApprovalGateway, approvalDigest } from './gateway.js';
import { createApprovalBrowserHandler } from './browser.js';
import { fixture } from './testing.fixture.js';
const signal = () => new AbortController().signal;
async function staged() {
  const f = fixture();
  const view = await f.gateway.stage(f.binding, f.input, signal());
  return { ...f, ref: view.ref };
}

it('freezes actual bytes and sends only that version after a trusted approval', async () => {
  const f = fixture(),
    view = await f.gateway.stage(f.binding, f.input, signal());
  f.setSource('changed after staging');
  await expect(
    f.gateway.execute(f.binding, view.ref, signal()),
  ).rejects.toMatchObject({ code: 'NOT_CONFIRMED' });
  const decided = await f.gateway.decide(
    f.context,
    { ...view.ref, decision: 'approved' },
    signal(),
  );
  expect(decided.ref).toEqual(view.ref);
  const received = await f.gateway.execute(
    { ...f.binding, native: { ...f.binding.native, callId: randomUUID() } },
    view.ref,
    signal(),
  );
  expect(received.effect).toBe('received');
  expect(
    Buffer.from(
      f.accepted.get(view.ref.requestId)!.payload.attachments[0]!.base64,
      'base64',
    ).toString(),
  ).toBe('frozen source');
  expect(JSON.stringify(view)).not.toContain('base64');
  expect((await f.gateway.view(f.context, view.ref, signal())).receipt).toEqual(
    received.receipt,
  );
});
it('uses canonical digest independent of PostgreSQL jsonb object key ordering', () => {
  expect(approvalDigest({ a: 1, b: { c: 2, d: 3 } })).toBe(
    approvalDigest({ b: { d: 3, c: 2 }, a: 1 }),
  );
});
it('returns same stage identity for an exact retry and rejects changed content', async () => {
  const f = fixture(),
    a = await f.gateway.stage(f.binding, f.input, signal());
  expect((await f.gateway.stage(f.binding, f.input, signal())).ref).toEqual(
    a.ref,
  );
  await expect(
    f.gateway.stage(f.binding, { ...f.input, body: 'changed' }, signal()),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
});
it.each(['approved', 'approvedBy', 'ownerId'])(
  'does not accept guest authority field %s',
  async (field) => {
    const f = fixture();
    await expect(
      f.gateway.stage(f.binding, { ...f.input, [field]: true }, signal()),
    ).rejects.toThrow();
  },
);
it('rejects content/digest changes, foreign identity, and a new VM epoch', async () => {
  const f = await staged();
  await expect(
    f.gateway.decide(
      f.context,
      { ...f.ref, digest: '0'.repeat(64), decision: 'approved' },
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(
    f.gateway.view(
      { ...f.context, actor: { type: 'user', id: randomUUID() } },
      { ...f.ref, digest: '0'.repeat(64) },
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'DENIED' });
  await expect(
    f.gateway.execute(
      { ...f.binding, vm: { ...f.binding.vm, leaseEpoch: 2 } },
      f.ref,
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'DENIED' });
  await expect(
    f.gateway.execute(f.binding, { ...f.ref, body: 'replacement' }, signal()),
  ).rejects.toThrow();
});
it('withdrawal after approval prevents claim and dispatch', async () => {
  const f = fixture(),
    view = await f.gateway.stage(f.binding, f.input, signal());
  await f.gateway.decide(
    f.context,
    { ...view.ref, decision: 'approved' },
    signal(),
  );
  f.setPermitted(false);
  await expect(
    f.gateway.execute(f.binding, view.ref, signal()),
  ).rejects.toMatchObject({ code: 'DENIED' });
  expect(f.dispatches).toBe(0);
  expect((await f.store.get(view.ref.requestId))!.intentAt).toBeNull();
});
it('parallel execute calls claim once; revoke cannot pretend to retract received bytes', async () => {
  const f = fixture(),
    view = await f.gateway.stage(f.binding, f.input, signal());
  await f.gateway.decide(
    f.context,
    { ...view.ref, decision: 'approved' },
    signal(),
  );
  await Promise.all(
    Array.from({ length: 8 }, () =>
      f.gateway.execute(f.binding, view.ref, signal()),
    ),
  );
  expect(f.dispatches).toBe(1);
  expect(f.accepted.size).toBe(1);
  await expect(
    f.gateway.revoke(f.context, view.ref, signal()),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
});
it('reconciles commit-before-ack after gateway reconstruction without dispatching again', async () => {
  const f = fixture(),
    view = await f.gateway.stage(f.binding, f.input, signal());
  await f.gateway.decide(
    f.context,
    { ...view.ref, decision: 'approved' },
    signal(),
  );
  f.loseAck();
  expect((await f.gateway.execute(f.binding, view.ref, signal())).effect).toBe(
    'unknown',
  );
  const restarted = createApprovalGateway(f.options);
  expect((await restarted.execute(f.binding, view.ref, signal())).effect).toBe(
    'unknown',
  );
  expect(
    (await restarted.reconcile(f.context, view.ref, signal())).effect,
  ).toBe('received');
  expect(f.dispatches).toBe(1);
});
it('keeps an unqueryable effect unknown, never treating timeout as permission to resend', async () => {
  const f = fixture(),
    view = await f.gateway.stage(f.binding, f.input, signal());
  await f.gateway.decide(
    f.context,
    { ...view.ref, decision: 'approved' },
    signal(),
  );
  f.loseAck();
  f.hideReceipt();
  await f.gateway.execute(f.binding, view.ref, signal());
  expect(
    (await f.gateway.reconcile(f.context, view.ref, signal())).effect,
  ).toBe('unknown');
  await f.gateway.execute(f.binding, view.ref, signal());
  expect(f.dispatches).toBe(1);
});
it('rejected and revoked approvals cannot be consumed or resurrected', async () => {
  const f = await staged();
  await f.gateway.decide(
    f.context,
    { ...f.ref, decision: 'rejected' },
    signal(),
  );
  await expect(
    f.gateway.decide(f.context, { ...f.ref, decision: 'approved' }, signal()),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  await f.gateway.revoke(f.context, f.ref, signal());
  await expect(
    f.gateway.execute(f.binding, f.ref, signal()),
  ).rejects.toMatchObject({ code: 'REVOKED' });
});
it('trusted BFF rejects foreign Origin, CSRF and guest fields; confirms exact requestId', async () => {
  const f = await staged();
  const handle = createApprovalBrowserHandler({
    gateway: f.gateway,
    trustedOrigin: 'https://allrice.test',
    guestOrigins: ['https://vm.allrice.test'],
    maxRequestBytes: 2000,
    authenticate: async () => f.context,
    assertCsrf: async (req) => {
      if (req.headers.get('x-csrf') !== 'fixture-only') throw Error('bad csrf');
    },
  });
  const request = (
    headers: Record<string, string>,
    body: unknown = { ...f.ref, decision: 'approved' },
  ) =>
    new Request('https://allrice.test/approvals/decide', {
      method: 'POST',
      headers: {
        origin: 'https://allrice.test',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        'x-csrf': 'fixture-only',
        ...headers,
      },
      body: JSON.stringify(body),
    });
  expect(
    (await handle(request({ origin: 'https://vm.allrice.test' }))).status,
  ).toBe(403);
  expect((await handle(request({ 'x-csrf': 'wrong' }))).status).not.toBe(200);
  expect(
    (
      await handle(
        request(
          {},
          { ...f.ref, decision: 'approved', approvedBy: f.context.actor.id },
        ),
      )
    ).status,
  ).toBe(400);
  expect((await f.store.get(f.ref.requestId))!.decision).toBe('pending');
  const approved = await handle(request({}));
  expect(approved.status).toBe(200);
  expect((await approved.json()).ref).toEqual(f.ref);
  expect(approved.headers.get('x-frame-options')).toBe('DENY');
});

it('keeps one business request across qualified native call retries in the same scope', async () => {
  const f = fixture(),
    view = await f.gateway.stage(f.binding, f.input, signal());
  const retry = await f.gateway.stage(
    { ...f.binding, native: { ...f.binding.native, callId: randomUUID() } },
    f.input,
    signal(),
  );
  expect(retry.ref).toEqual(view.ref);
  expect((await f.store.get(view.ref.requestId))!.binding.native.callId).toBe(
    f.binding.native.callId,
  );
});
it('rechecks withdrawal at dispatch admission, after the earlier permission read', async () => {
  const f = fixture(),
    view = await f.gateway.stage(f.binding, f.input, signal());
  await f.gateway.decide(
    f.context,
    { ...view.ref, decision: 'approved' },
    signal(),
  );
  const gateway = createApprovalGateway({
    ...f.options,
    authority: {
      ...f.options.authority,
      admit: async (_binding, callback) => {
        f.setPermitted(false);
        return callback();
      },
    },
  });
  await expect(
    gateway.execute(f.binding, view.ref, signal()),
  ).rejects.toMatchObject({ code: 'DENIED' });
  expect(f.dispatches).toBe(0);
  expect((await f.store.get(view.ref.requestId))!.intentAt).toBeNull();
});
it('passes actual cancellation to the in-flight destination while preserving unknown effect', async () => {
  const f = fixture(),
    view = await f.gateway.stage(f.binding, f.input, signal());
  await f.gateway.decide(
    f.context,
    { ...view.ref, decision: 'approved' },
    signal(),
  );
  let began!: () => void,
    aborted = false;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const controller = new AbortController();
  const gateway = createApprovalGateway({
    ...f.options,
    destinations: {
      inbox: {
        ...f.options.destinations.inbox,
        dispatch: async (_ref, _payload, signal) => {
          began();
          await new Promise<void>((resolve) =>
            signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            ),
          );
          signal.throwIfAborted();
          throw Error('unreachable');
        },
      },
    },
  });
  const executing = gateway.execute(f.binding, view.ref, controller.signal);
  await started;
  controller.abort();
  expect((await executing).effect).toBe('unknown');
  expect(aborted).toBe(true);
});
it('does not trust stored bytes whose frozen digest no longer matches', async () => {
  const f = fixture(),
    view = await f.gateway.stage(f.binding, f.input, signal());
  const gateway = createApprovalGateway({
    ...f.options,
    store: {
      ...f.store,
      get: async (id) => {
        const record = await f.store.get(id);
        return (
          record && {
            ...record,
            payload: { ...record.payload, body: 'tampered' },
          }
        );
      },
    },
  });
  await expect(
    gateway.view(f.context, view.ref, signal()),
  ).rejects.toMatchObject({ code: 'INTEGRITY' });
});
it('rejects over-budget bytes and unknown resource/destination registrations without staging', async () => {
  const f = fixture();
  await expect(
    f.gateway.stage(
      f.binding,
      { ...f.input, body: 'x'.repeat(5001) },
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  await expect(
    f.gateway.stage(
      f.binding,
      { ...f.input, adapterId: 'unregistered' },
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'DENIED' });
  await expect(
    f.gateway.stage(
      f.binding,
      { ...f.input, attachments: [{ module: 'unregistered', ref: 'x' }] },
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'DENIED' });
});

it('serves the exact frozen attachment for trusted preview after the mutable source changes', async () => {
  const f = fixture(),
    view = await f.gateway.stage(f.binding, f.input, signal());
  f.setSource('new version');
  expect(
    (
      await f.gateway.attachment(f.context, { ...view.ref, index: 0 }, signal())
    ).bytes.toString(),
  ).toBe('frozen source');
  f.setPermitted(false);
  await expect(
    f.gateway.attachment(f.context, { ...view.ref, index: 0 }, signal()),
  ).rejects.toThrow();
});
