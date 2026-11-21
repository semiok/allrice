import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { DataAccessError } from '@allrice/database';
import type { DEntryIdentity, RequestContext } from '@allrice/contracts';
import { POST as owner } from '../../app/api/v1/d-entry/native-owner/route';
import { POST as resource } from '../../app/api/v1/d-entry/native-resource/route';
import { POST as rpc } from '../../app/api/v1/d-entry/native-rpc/route';
import { POST as root } from '../../app/api/v1/d-entry/native-root/route';

const ports = vi.hoisted(() => ({
  context: vi.fn(),
  identity: vi.fn(),
  token: 'original_browser_session_token',
}));
vi.mock('../identity/session', () => ({
  requireRequestContext: ports.context,
  sessionCookieName: 'allrice_session',
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (ports.token ? { value: ports.token } : undefined),
  }),
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  resolveDEntryIdentity: ports.identity,
}));

const identity: DEntryIdentity = {
  organizationId: randomUUID(),
  workspaceId: randomUUID(),
  personId: randomUUID(),
  employeeInstanceId: randomUUID(),
  employeeRevision: 1,
  employeeVersionId: randomUUID(),
  threadId: randomUUID(),
};
const context: RequestContext = {
  requestId: randomUUID(),
  sessionId: randomUUID(),
  actor: { type: 'user', id: identity.personId },
  organizationId: identity.organizationId,
  workspaceId: identity.workspaceId,
  memberships: [],
  authenticatedAt: new Date().toISOString(),
};
const selection = {
  workspaceId: identity.workspaceId,
  employeeInstanceId: identity.employeeInstanceId,
  threadId: identity.threadId!,
};
const discovery = () => ({
  identity,
  bindingRef: 'exact-native-owner',
  controlReady: true,
  receipt: { endpoints: [{ hostPort: 12345 }], nativeCookie: 'never-return' },
});
function request(body: unknown, origin = 'https://allrice.test') {
  return new Request('https://allrice.test/api/v1/d-entry/native-owner', {
    method: 'POST',
    headers: { host: 'allrice.test', origin },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  ports.token = 'original_browser_session_token';
  ports.context.mockReset().mockResolvedValue(context);
  ports.identity.mockReset().mockResolvedValue(identity);
  vi.stubEnv('ALLRICE_WORKER_INTERNAL_URL', 'http://worker.internal:3101');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Web original-cookie to fixed Worker adapters', () => {
  it('forwards only selectors for explicit native root creation and validates the returned root', async () => {
    const native = {
      organizationId: identity.organizationId,
      personId: identity.personId,
      employeeInstanceId: identity.employeeInstanceId,
      threadId: identity.threadId,
      nativeSessionId: 'actual-created-root',
      rootNativeSessionId: 'actual-created-root',
      parentNativeSessionId: null,
      bindingRef: 'exact-native-owner',
    };
    const fetch = vi.fn(async () => Response.json(native));
    vi.stubGlobal('fetch', fetch);
    expect(
      (await root(request({ selection, nativeSessionId: 'guest-root' })))
        .status,
    ).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(await (await root(request({ selection }))).json()).toEqual(native);
    const [url, options] = fetch.mock.calls[0]! as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.pathname).toBe('/internal/d-entry/native-root');
    expect(JSON.parse(String(options.body))).toEqual({
      organizationId: context.organizationId,
      selection,
    });
    fetch.mockResolvedValueOnce(
      Response.json({ ...native, parentNativeSessionId: 'other-root' }),
    );
    expect((await root(request({ selection }))).status).toBe(403);
  });
  it('authenticates current selection, forwards only original Bearer, and hides endpoint/native auth/editor readiness', async () => {
    const fetch = vi.fn(async () => Response.json(discovery()));
    vi.stubGlobal('fetch', fetch);
    const response = await owner(request(selection));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      mount: {
        identity,
        executionGeneration: '4.0',
        bindingRef: 'exact-native-owner',
      },
      controlReady: true,
    });
    expect(body.mount.remountKey).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(body)).not.toMatch(
      /hostPort|nativeCookie|never-return|editorReady|canSend/,
    );
    expect(ports.identity).toHaveBeenCalledWith(context, selection, 'execute');
    const [url, options] = fetch.mock.calls[0]! as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.href).toBe(
      'http://worker.internal:3101/internal/d-entry/native-owner',
    );
    expect(options.redirect).toBe('error');
    expect(options.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer original_browser_session_token',
    });
    expect(JSON.parse(String(options.body))).toEqual({
      organizationId: identity.organizationId,
      selection,
    });
  });

  it('rejects changed owner, current-authority denial, foreign origin and absent original cookie', async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        ...discovery(),
        identity: { ...identity, personId: randomUUID() },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    expect((await owner(request(selection))).status).toBe(403);
    fetch.mockClear();
    ports.identity.mockRejectedValueOnce(
      new DataAccessError('authorization_denied'),
    );
    expect((await owner(request(selection))).status).toBe(403);
    expect(
      (await owner(request(selection, 'https://foreign.invalid'))).status,
    ).toBe(403);
    ports.token = '';
    expect((await owner(request(selection))).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not fall back after a Worker denial and preserves the public error contract', async () => {
    const problem = {
      error: {
        code: 'DEPENDENCY_UNAVAILABLE',
        requestId: randomUUID(),
        message: 'Not available',
        retryable: false,
      },
    };
    const fetch = vi.fn(async () => Response.json(problem, { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    const response = await owner(request(selection));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(problem);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.stubEnv(
      'ALLRICE_WORKER_INTERNAL_URL',
      'https://user:secret@foreign.invalid',
    );
    expect((await owner(request(selection))).status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns only the exact resource and refuses a mismatched thread/session projection', async () => {
    const facts = {
      organizationId: identity.organizationId,
      personId: identity.personId,
      employeeInstanceId: identity.employeeInstanceId,
      threadId: identity.threadId!,
      nativeSessionId: 'dsh-child',
      rootNativeSessionId: 'dsh-root',
      parentNativeSessionId: 'dsh-root',
      bindingRef: 'exact-native-owner',
    };
    const fetch = vi.fn(async () => Response.json(facts));
    vi.stubGlobal('fetch', fetch);
    expect(
      await (
        await resource(request({ selection, nativeSessionId: 'dsh-child' }))
      ).json(),
    ).toEqual(facts);
    fetch.mockImplementationOnce(async () =>
      Response.json({ ...facts, threadId: randomUUID() }),
    );
    expect(
      (await resource(request({ selection, nativeSessionId: 'dsh-child' })))
        .status,
    ).toBe(403);
  });

  it('passes the native RPC body without native cookies, arbitrary proxy URLs or browser identity', async () => {
    const fetch = vi.fn(
      async () =>
        new Response('native-result', {
          headers: {
            'set-cookie': 'native=secret',
            'content-type': 'application/json',
          },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const payload = { args: { request: { sessionId: 'dsh-root' } } };
    const response = await rpc(
      request({ selection, endpoint: 'session/cancel', payload }),
    );
    expect(await response.text()).toBe('native-result');
    expect(response.headers.get('set-cookie')).toBeNull();
    const [url, options] = fetch.mock.calls[0]! as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.pathname).toBe('/internal/d-entry/native-rpc');
    expect(JSON.parse(String(options.body))).toEqual({
      organizationId: identity.organizationId,
      selection,
      endpoint: 'session/cancel',
      payload,
    });
    expect(
      (
        await rpc(
          request({
            selection,
            endpoint: 'session/cancel',
            payload,
            upstreamUrl: 'https://foreign.invalid',
          }),
        )
      ).status,
    ).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
