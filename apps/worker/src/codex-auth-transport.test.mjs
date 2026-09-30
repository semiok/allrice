/* global AbortController, Response */
import { describe, it, expect, vi } from 'vitest';
import { codexAuthorizationFetch } from '../dsh/allrice-codex-auth-transport.mjs';

const endpoint = 'https://auth.openai.com/api/accounts/deviceauth/';
const input = { method: 'POST', body: '{"client_id":"synthetic"}' };
const reset = () =>
  new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
describe('native Codex authorization transport recovery', () => {
  it.each(['usercode', 'token'])(
    'recovers %s without changing its request or challenge',
    async (path) => {
      const response = Response.json({ user_code: 'SAME-CODE' });
      const raw = vi
        .fn()
        .mockRejectedValueOnce(reset())
        .mockResolvedValue(response);
      const wait = vi.fn().mockResolvedValue(undefined);
      const fetch = codexAuthorizationFetch(raw, { wait });
      expect(await fetch(endpoint + path, input)).toBe(response);
      expect(raw).toHaveBeenCalledTimes(2);
      expect(raw.mock.calls.map(([, options]) => options.body)).toEqual([
        input.body,
        input.body,
      ]);
      expect(wait).toHaveBeenCalledTimes(1);
    },
  );
  it('bounds network retries and never propagates a credential-bearing cause', async () => {
    const raw = vi
      .fn()
      .mockRejectedValue(new Error('fetch failed secret-payload'));
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(
      codexAuthorizationFetch(raw, { wait })(endpoint + 'usercode', input),
    ).rejects.toThrow(/^codex_authorization_network_unavailable$/);
    expect(raw).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
  });
  it('recovers a temporary upstream 503', async () => {
    const response = Response.json({ user_code: 'SAME-CODE' });
    const raw = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValue(response);
    expect(
      await codexAuthorizationFetch(raw, { wait: async () => {} })(
        endpoint + 'usercode',
        input,
      ),
    ).toBe(response);
    expect(raw).toHaveBeenCalledTimes(2);
  });
  it.each([401, 403, 404, 429])(
    'preserves native %s polling and authorization responses',
    async (status) => {
      const response = new Response('', { status });
      const raw = vi.fn().mockResolvedValue(response);
      expect(
        await codexAuthorizationFetch(raw)(endpoint + 'token', input),
      ).toBe(response);
      expect(raw).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    'https://auth.openai.com/oauth/token',
    'https://chatgpt.com/backend-api/codex/responses',
    'https://example.com/api/accounts/deviceauth/usercode',
  ])('never replays %s', async (url) => {
    const raw = vi.fn().mockRejectedValue(reset());
    await expect(codexAuthorizationFetch(raw)(url, input)).rejects.toThrow(
      'fetch failed',
    );
    expect(raw).toHaveBeenCalledTimes(1);
  });
  it('cancellation during backoff prevents a second request', async () => {
    const controller = new AbortController();
    const raw = vi.fn().mockRejectedValue(reset());
    const wait = async () => {
      controller.abort(new Error('canceled'));
    };
    await expect(
      codexAuthorizationFetch(raw, { wait })(endpoint + 'usercode', {
        ...input,
        signal: controller.signal,
      }),
    ).rejects.toThrow('canceled');
    expect(raw).toHaveBeenCalledTimes(1);
  });
});
