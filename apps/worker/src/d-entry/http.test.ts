import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataAccessError } from '@allrice/database';
import * as admission from '../../../../packages/database/src/d-entry-admission.ts';
import { nativeEntryServer, deferred } from './native-entry.fixture.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await nativeEntryServer();
  let unknown = false;
  cleanups.push(async () => {
    if (unknown)
      await expect(f.close()).rejects.toThrow('Entry fixture cleanup unknown');
    else await f.close();
  });
  return {
    ...f,
    expectUnknownClose() {
      unknown = true;
    },
  };
}
const prompt = (sessionId = 'dsh-root') => ({
  endpoint: 'session/prompt',
  payload: {
    args: {
      request: {
        requestId: 'fixture-browser-message',
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'hello' }],
      },
    },
  },
});

describe('same-listener original-session native HTTP adapters', () => {
  it('keeps direct internal root/RPC/resource entry closed without the real data provider or control readiness', async () => {
    const f = await fixture(),
      control = vi.spyOn(f.owner, 'controlReady');
    for (const missing of ['data', 'control', 'envelope'] as const) {
      f.deps.data.mockReturnValue(missing === 'data' ? undefined : f.data);
      control.mockReturnValue(missing !== 'control');
      if (missing === 'envelope')
        vi.mocked(f.data.resolveAdmissionOwner).mockRejectedValue(
          Error('real complete envelope unavailable'),
        );
      for (const [path, body] of [
        ['native-root', f.body],
        ['native-rpc', { ...f.body, ...prompt() }],
        ['native-resource', { ...f.body, nativeSessionId: 'dsh-child' }],
      ] as const)
        expect((await f.request(path, body)).status).toBe(503);
    }
    expect(f.data.acquireRoot).not.toHaveBeenCalled();
    expect(f.data.acquireRpc).not.toHaveBeenCalled();
    expect(f.owner.readSessions).not.toHaveBeenCalled();
    expect(f.deps.ensureRoot).not.toHaveBeenCalled();
    expect(f.admission.boundary.admit).not.toHaveBeenCalled();
    control.mockReturnValue(false);
    const discovery = await f.request();
    expect(await discovery.json()).toMatchObject({ controlReady: false });
  });

  it('creates a root only from the trusted generated native reply and never accepts a browser root/preset', async () => {
    const f = await fixture();
    for (const field of [
      { nativeSessionId: 'guest-root' },
      { agentPreset: 'guest-preset' },
      { receipt: {} },
    ])
      expect(
        (await f.request('native-root', { ...f.body, ...field })).status,
      ).toBe(400);
    expect(f.data.acquireRoot).not.toHaveBeenCalled();
    const response = await f.request('native-root');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      rootNativeSessionId: 'dsh-created-by-host',
      nativeSessionId: 'dsh-created-by-host',
      parentNativeSessionId: null,
    });
    expect(f.data.acquireRoot).toHaveBeenCalledWith(
      { owner: f.owner, request: {} },
      expect.any(AbortSignal),
    );
    expect(f.rootCreate).toHaveBeenCalledTimes(1);
    expect(f.rootClose).toHaveBeenCalledTimes(1);
    expect(f.admission.boundary.finish).toHaveBeenCalledTimes(1);
    expect(f.owner.readSessions).not.toHaveBeenCalled();
    expect(f.deps.ensureRoot).toHaveBeenCalledWith(
      f.context,
      f.selection,
      f.identity,
      expect.objectContaining({
        create: expect.any(Function),
        operationId: expect.any(String),
      }),
    );
  });

  it('rechecks authority before acquiring a root handle and finishes unknown root acquisition without claiming it joined', async () => {
    const f = await fixture();
    f.expectUnknownClose();
    vi.mocked(f.admission.boundary.admit).mockImplementationOnce(async () => {
      f.deps.identity.mockResolvedValue({ ...f.identity, employeeRevision: 2 });
      return f.permit;
    });
    expect((await f.request('native-root')).status).toBe(404);
    expect(f.data.acquireRoot).not.toHaveBeenCalled();
    f.deps.identity.mockResolvedValue(f.identity);
    vi.mocked(f.data.acquireRoot).mockImplementationOnce(() => {
      throw Error('root partial init unknown');
    });
    expect((await f.request('native-root')).status).toBe(503);
    expect(f.rootCreate).not.toHaveBeenCalled();
    expect(f.admission.boundary.finish).toHaveBeenCalledTimes(2);
  });

  for (const rejects of [false, true])
    it(`joins the FIRST body cancel promise before finish, preserving cancellation and unknown cleanup (reject=${rejects})`, async () => {
      const f = await fixture(),
        started = deferred<void>(),
        cleanup = deferred<void>(),
        nativeClosed = deferred<void>(),
        finished = deferred<void>();
      const cancelled = new Error('session membership revoked'),
        closeError = new Error('underlying body cancel unknown');
      if (rejects) f.expectUnknownClose();
      let callbackError: unknown;
      f.admission.boundary.activate = async (_permit, callback, signal) => {
        try {
          return await callback(signal);
        } catch (error) {
          callbackError = error;
          throw error;
        }
      };
      const cancel = vi.fn(() => {
        started.resolve();
        return cleanup.promise;
      });
      vi.mocked(f.data.acquireRpc).mockImplementationOnce((input) => ({
        run: (signal) =>
          input.consume(
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('opening'));
                },
                cancel,
              }),
            ),
            signal,
          ),
        close: async () => {
          nativeClosed.resolve();
        },
      }));
      vi.mocked(f.admission.boundary.finish).mockImplementationOnce(async () =>
        finished.resolve(),
      );
      const response = await f.request('native-rpc', {
        ...f.body,
        ...prompt(),
      });
      f.identityRevoked.abort(cancelled);
      await started.promise;
      await nativeClosed.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.admission.boundary.finish).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
      if (rejects) cleanup.reject(closeError);
      else cleanup.resolve();
      await expect(response.text()).rejects.toThrow();
      await finished.promise;
      expect(cancel).toHaveBeenCalledTimes(1);
      if (rejects) {
        const errors: unknown[] = [];
        const collect = (error: unknown) => {
          if (errors.includes(error)) return;
          errors.push(error);
          if (error instanceof AggregateError) error.errors.forEach(collect);
          if (error instanceof Error && error.cause) collect(error.cause);
        };
        collect(callbackError);
        expect(errors).toContain(cancelled);
        expect(errors).toContain(closeError);
      } else expect(callbackError).toBeUndefined();
      await vi.waitFor(() => expect(f.authorityClose).toHaveBeenCalledTimes(1));
      // No fixture assertion here establishes the real producer's PG retention.
    });

  it.each([
    { cancelRejects: false, finishRejects: false },
    { cancelRejects: true, finishRejects: false },
    { cancelRejects: true, finishRejects: true },
  ])(
    'joins late body cancel before finish ($cancelRejects/$finishRejects), preserving E/C/F',
    async ({ cancelRejects, finishRejects }) => {
      const f = await fixture(),
        reading = new AbortController(),
        cancelStarted = deferred<void>(),
        cleanup = deferred<void>(),
        finished = deferred<void>();
      if (cancelRejects || finishRejects) f.expectUnknownClose();
      const original = Error('late reading cancellation'),
        closeError = Error('late body cleanup unknown'),
        finishError = Error('finish acknowledgement unknown'),
        events: string[] = [];
      let running: Promise<void> | undefined,
        callbackError: unknown,
        outerError: unknown;
      const fulfilled = vi.fn();
      const actualRun = admission.runDEntryAdmittedActivity;
      const run = vi
        .spyOn(admission, 'runDEntryAdmittedActivity')
        .mockImplementation(async (...args) => {
          try {
            return await actualRun(...args);
          } catch (error) {
            outerError = error;
            throw error;
          }
        });
      f.admission.boundary.activate = async (_permit, callback, signal) => {
        try {
          const outcome = await callback(signal);
          fulfilled(outcome);
          return outcome;
        } catch (error) {
          callbackError = error;
          throw error;
        }
      };
      const cancel = vi.fn(() => {
        events.push('body-cancel');
        cancelStarted.resolve();
        return cleanup.promise;
      });
      const nativeClose = vi.fn(async () => {
        events.push('native-close');
        reading.abort(original); // The run signal never directly aborts this controller.
        await running?.catch(() => {}); // Transport joined; entry body cleanup is a separate fact.
        events.push('native-joined');
      });
      vi.mocked(f.data.acquireRpc).mockImplementationOnce((input) => ({
        run() {
          return (running = input.consume(
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('opening'));
                },
                cancel,
              }),
            ),
            reading.signal,
          ));
        },
        close: nativeClose,
      }));
      vi.mocked(f.admission.boundary.finish).mockImplementationOnce(
        async () => {
          events.push('finish');
          finished.resolve();
          if (finishRejects) throw finishError;
        },
      );
      try {
        const response = await f.request('native-rpc', {
          ...f.body,
          ...prompt(),
        });
        f.identityRevoked.abort(original);
        await cancelStarted.promise;
        expect(events).toEqual(['native-close', 'body-cancel']);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(nativeClose).toHaveBeenCalledTimes(1);
        expect(fulfilled).not.toHaveBeenCalled();
        expect(f.admission.boundary.finish).not.toHaveBeenCalled();
        if (cancelRejects) cleanup.reject(closeError);
        else cleanup.resolve();
        await expect(response.text()).rejects.toThrow();
        await finished.promise;
        await vi.waitFor(() =>
          expect(f.authorityClose).toHaveBeenCalledTimes(1),
        );
        expect(events).toEqual([
          'native-close',
          'body-cancel',
          'native-joined',
          'finish',
        ]);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(nativeClose).toHaveBeenCalledTimes(1);
        expect(f.admission.boundary.finish).toHaveBeenCalledTimes(1);
        const errors: unknown[] = [];
        const collect = (error: unknown) => {
          if (errors.includes(error)) return;
          errors.push(error);
          if (error instanceof AggregateError) error.errors.forEach(collect);
          if (error instanceof Error && error.cause) collect(error.cause);
        };
        collect(outerError);
        expect(errors).toContain(original);
        if (cancelRejects) {
          expect(fulfilled).not.toHaveBeenCalled();
          expect(callbackError).toBeInstanceOf(AggregateError);
          expect(errors).toContain(closeError);
        } else {
          expect(callbackError).toBeUndefined();
          expect(fulfilled).toHaveBeenCalledWith({
            ok: false,
            error: original,
          });
          expect(outerError).toBe(original);
        }
        if (finishRejects) expect(errors).toContain(finishError);
        // Actual helper observed above; fake boundary still proves no PG retention.
      } finally {
        cleanup.resolve();
        run.mockRestore();
      }
    },
  );

  it('reauthenticates the original Bearer and emits only host discovery, not editor/send readiness', async () => {
    const f = await fixture();
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      identity: f.identity,
      bindingRef: f.owner.bindingRef,
      controlReady: true,
    });
    expect(f.deps.authenticate).toHaveBeenCalledTimes(3);
    expect(f.deps.authenticate).toHaveBeenCalledWith(
      'original_session_opaque_token',
      {
        organizationId: f.identity.organizationId,
        workspaceId: f.identity.workspaceId,
      },
    );
    expect(f.owner.readSessions).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(f.data.acquireRpc).not.toHaveBeenCalled();
  });

  it('rejects forged identity, stale login, viewer/current-authority denial and Origin before native acquisition', async () => {
    const f = await fixture();
    expect(
      (await f.request('native-owner', { ...f.body, context: f.context }))
        .status,
    ).toBe(400);
    expect(
      (
        await f.request('native-owner', f.body, {
          origin: 'https://browser.invalid',
        })
      ).status,
    ).toBe(404);
    f.deps.authenticate.mockResolvedValueOnce(null);
    expect((await f.request()).status).toBe(401);
    f.deps.identity.mockRejectedValueOnce(
      new DataAccessError('authorization_denied'),
    );
    expect((await f.request()).status).toBe(404);
    expect(f.deps.owners.resolve).not.toHaveBeenCalled();
    expect(f.data.acquireRpc).not.toHaveBeenCalled();
  });

  it('rejects endpoint substitution/duplicate receipt and keeps an absent data provider unavailable', async () => {
    const f = await fixture();
    f.deps.owners.resolve.mockResolvedValueOnce({
      ...f.owner,
      receipt: { ...f.owner.receipt, endpoints: [f.endpoint, f.endpoint] },
    });
    expect((await f.request()).status).toBe(404);
    f.deps.owners.resolve.mockResolvedValueOnce({
      ...f.owner,
      endpoint: { ...f.endpoint, hostPort: 54321 },
    });
    expect((await f.request()).status).toBe(404);
    f.deps.data.mockReturnValueOnce(undefined);
    expect(
      (await f.request('native-rpc', { ...f.body, ...prompt() })).status,
    ).toBe(503);
    expect(f.data.acquireRpc).not.toHaveBeenCalled();
  });

  it('combines the immutable SaaS root with complete native ancestry and rejects cross-root/missing-pin access', async () => {
    const f = await fixture();
    vi.mocked(f.owner.readSessions).mockImplementation(async () => {
      expect(f.admission.boundary.admit).toHaveBeenCalled();
      return { ok: true, value: f.catalog };
    });
    const response = await f.request('native-resource', {
      ...f.body,
      nativeSessionId: 'dsh-grandchild',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      rootNativeSessionId: 'dsh-root',
      parentNativeSessionId: 'dsh-child',
      threadId: f.identity.threadId,
    });
    expect(
      (
        await f.request('native-resource', {
          ...f.body,
          nativeSessionId: 'dsh-foreign',
        })
      ).status,
    ).toBe(404);
    f.root.mockRejectedValueOnce(new Error('NATIVE_QUERY_BINDING_UNAVAILABLE'));
    expect(
      (
        await f.request('native-resource', {
          ...f.body,
          nativeSessionId: 'dsh-root',
        })
      ).status,
    ).toBe(503);
    expect(f.data.acquireRpc).not.toHaveBeenCalled();
  });

  it('blocks direct child writes before native side effects, preserving authorized root prompts and actual close/finish', async () => {
    const f = await fixture();
    expect(
      (await f.request('native-rpc', { ...f.body, ...prompt('dsh-child') }))
        .status,
    ).toBe(404);
    expect(f.rpcDispatch).not.toHaveBeenCalled();
    expect(f.rpcClose).toHaveBeenCalledTimes(1);
    expect(f.admission.boundary.finish).toHaveBeenCalledTimes(1);
    const response = await f.request('native-rpc', { ...f.body, ...prompt() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(f.data.acquireRpc).toHaveBeenCalledTimes(2);
    expect(f.rpcDispatch).toHaveBeenCalledTimes(1);
    expect(
      JSON.stringify(vi.mocked(f.data.acquireRpc).mock.calls),
    ).not.toContain('original_session_opaque_token');
    expect(f.rpcClose).toHaveBeenCalledTimes(2);
    expect(f.admission.boundary.finish).toHaveBeenCalledTimes(2);
  });

  it('rechecks authority after admit before acquire, and always finishes an unknown acquire/close', async () => {
    const f = await fixture();
    f.expectUnknownClose();
    vi.mocked(f.admission.boundary.admit).mockImplementationOnce(async () => {
      f.deps.identity.mockResolvedValue({ ...f.identity, employeeRevision: 2 });
      return f.permit;
    });
    expect(
      (await f.request('native-rpc', { ...f.body, ...prompt() })).status,
    ).toBe(404);
    expect(f.data.acquireRpc).not.toHaveBeenCalled();
    expect(f.admission.boundary.finish).toHaveBeenCalledTimes(1);
    f.deps.identity.mockResolvedValue(f.identity);
    const unknown = new Error('partial init did not return an owner handle');
    vi.mocked(f.data.acquireRpc).mockImplementationOnce(() => {
      throw unknown;
    });
    expect(
      (await f.request('native-rpc', { ...f.body, ...prompt() })).status,
    ).toBe(503);
    expect(f.admission.boundary.finish).toHaveBeenCalledTimes(2);
    const business = new Error('provider failed'),
      close = new Error('close unknown');
    vi.mocked(f.data.acquireRpc).mockReturnValueOnce({
      run: async () => {
        throw business;
      },
      close: async () => {
        throw close;
      },
    });
    expect(
      (await f.request('native-rpc', { ...f.body, ...prompt() })).status,
    ).toBe(503);
    expect(f.admission.boundary.finish).toHaveBeenCalledTimes(3);
    vi.mocked(f.owner.readSessions).mockRejectedValueOnce(
      new Error('catalog transport join unknown'),
    );
    expect(
      (
        await f.request('native-resource', {
          ...f.body,
          nativeSessionId: 'dsh-root',
        })
      ).status,
    ).toBe(503);
    expect(f.admission.boundary.finish).toHaveBeenCalledTimes(4);
    // This double proves invocation only; no claim about sticky PG retention.
  });

  it('revocation during an idle HTTP body actively cancels the read and joins the owned handle before finish', async () => {
    const f = await fixture(),
      closed = deferred<void>(),
      finished = deferred<void>();
    let joined = false;
    vi.mocked(f.data.acquireRpc).mockImplementationOnce((input) => ({
      run: (signal) =>
        input.consume(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('opening'));
              },
              cancel() {
                joined = true;
                closed.resolve();
              },
            }),
          ),
          signal,
        ),
      close: async () => {
        await closed.promise;
        expect(joined).toBe(true);
      },
    }));
    vi.mocked(f.admission.boundary.finish).mockImplementationOnce(async () => {
      expect(joined).toBe(true);
      finished.resolve();
    });
    const response = await f.request('native-rpc', { ...f.body, ...prompt() });
    expect(f.admission.boundary.finish).not.toHaveBeenCalled();
    f.authorization.abort(new Error('current session revoked'));
    await expect(response.text()).rejects.toThrow();
    await finished.promise;
  });
});
