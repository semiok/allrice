import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataAccessError } from '@allrice/database';
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
