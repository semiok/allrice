import { describe, expect, it, vi } from 'vitest';
import { FixedRepositoryGithub } from './github.js';

const token = 'github_pat_' + 'SyntheticFixtureOnly'.repeat(5);
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });
describe('fixed private GitHub transport boundaries', () => {
  it('denies writes before dispatch for the repository review client', async () => {
    const gate = vi.fn(async () => ({ token, remainingMs: 30000 })),
      transport = vi.fn<typeof fetch>();
    const client = new FixedRepositoryGithub(
      gate,
      new AbortController().signal,
      transport,
      true,
    );
    await expect(
      client.createBlob(Buffer.from('synthetic').toString('base64')),
    ).rejects.toThrow();
    expect(gate).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
  it('downloads the artifact through a bounded storage ticket without forwarding credentials', async () => {
    const gate = vi.fn(async () => ({ token, remainingMs: 30000 }));
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location:
              'https://fixture.blob.core.windows.net/receipt?sig=synthetic',
          },
        }),
      )
      .mockResolvedValueOnce(new Response('zip'));
    const client = new FixedRepositoryGithub(
      gate,
      new AbortController().signal,
      transport,
    );
    expect((await client.downloadArtifact(7)).toString()).toBe('zip');
    expect(gate).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[0]![1]?.headers).toMatchObject({
      authorization: 'Bearer ' + token,
    });
    expect(transport.mock.calls[1]![1]).not.toHaveProperty('headers');
    expect(transport.mock.calls[1]![1]?.redirect).toBe('manual');
  });
  it('does not follow a foreign storage ticket or download after its authority budget expires', async () => {
    for (const expired of [false, true]) {
      const gate = vi
        .fn()
        .mockResolvedValueOnce({ token, remainingMs: 30000 })
        .mockResolvedValueOnce({ token, remainingMs: 0 });
      const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location: expired
              ? 'https://fixture.blob.core.windows.net/receipt'
              : 'https://foreign.test/receipt',
          },
        }),
      );
      const client = new FixedRepositoryGithub(
        gate,
        new AbortController().signal,
        transport,
      );
      await expect(client.downloadArtifact(7)).rejects.toMatchObject({
        code: expired
          ? 'REPOSITORY_REMOTE_UNAVAILABLE'
          : 'REPOSITORY_REMOTE_INVALID',
      });
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });
  it('uses only the registered origin and rechecks credentials before every request', async () => {
    const gate = vi.fn(async () => ({ token, remainingMs: 30_000 }));
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        ok({ id: 1323769790, full_name: 'semiok/allrice' }),
      )
      .mockResolvedValueOnce(
        ok({ ref: 'refs/heads/main', object: { sha: 'a'.repeat(40) } }),
      );
    const client = new FixedRepositoryGithub(
      gate,
      new AbortController().signal,
      transport,
    );
    expect(await client.repository()).toEqual({
      id: 1323769790,
      fullName: 'semiok/allrice',
    });
    expect(await client.main()).toBe('a'.repeat(40));
    expect(gate).toHaveBeenCalledTimes(2);
    for (const [url, options] of transport.mock.calls) {
      expect(new URL(String(url)).origin).toBe('https://api.github.com');
      expect(options?.redirect).toBe('manual');
      expect(options?.headers).toMatchObject({
        authorization: 'Bearer ' + token,
      });
    }
    gate.mockRejectedValueOnce(Error('AUTH_REVOKED'));
    await expect(client.main()).rejects.toThrow('AUTH_REVOKED');
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('never forwards the token through redirects or echoes a remote error body', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(token, {
          status: 307,
          headers: { location: 'https://foreign.test/credentials' },
        }),
      )
      .mockResolvedValueOnce(new Response(token, { status: 403 }));
    const client = new FixedRepositoryGithub(
      async () => ({ token, remainingMs: 30_000 }),
      new AbortController().signal,
      transport,
    );
    for (let i = 0; i < 2; i++) {
      const error = await client.repository().catch((e) => e);
      expect(error).toMatchObject({ code: 'REPOSITORY_REMOTE_UNAVAILABLE' });
      expect(error.message).not.toContain(token);
    }
    expect(transport).toHaveBeenCalledTimes(2);
    expect(
      transport.mock.calls.every(([u]) => !String(u).includes('foreign')),
    ).toBe(true);
  });
  it('bounds response bodies and rejects a different repository or malformed object', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok({ id: 5, full_name: 'semiok/allrice' }))
      .mockResolvedValueOnce(
        new Response('x'.repeat(2_000_001), { status: 200 }),
      );
    const client = new FixedRepositoryGithub(
      async () => ({ token, remainingMs: 30_000 }),
      new AbortController().signal,
      transport,
    );
    await expect(client.repository()).rejects.toMatchObject({
      code: 'REPOSITORY_REMOTE_INVALID',
    });
    await expect(client.repository()).rejects.toMatchObject({
      code: 'REPOSITORY_REMOTE_INVALID',
    });
    await expect(
      client.createBranch('main', 'a'.repeat(40)),
    ).rejects.toMatchObject({ code: 'REPOSITORY_REMOTE_INVALID' });
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('treats missing reads as observations, but a missing write response never as success', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const client = new FixedRepositoryGithub(
      async () => ({ token, remainingMs: 30_000 }),
      new AbortController().signal,
      transport,
    );
    expect(await client.commit('a'.repeat(40))).toBeNull();
    await expect(
      client.createBlob(Buffer.from('candidate').toString('base64')),
    ).rejects.toMatchObject({
      code: 'REPOSITORY_REMOTE_UNAVAILABLE',
      status: 404,
    });
    expect(transport.mock.calls[1]?.[1]?.method).toBe('POST');
  });
});
