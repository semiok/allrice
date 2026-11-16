import { describe, expect, it, vi } from 'vitest';
import { FixedRepositoryGithub } from './github.js';

const token = 'github_pat_' + 'SyntheticFixtureOnly'.repeat(5);
const treeId = 'a'.repeat(40);
const treeBlob = {
  path: 'file.ts',
  type: 'blob',
  mode: '100644',
  sha: 'b'.repeat(40),
};
const completeTree = { sha: treeId, truncated: false, tree: [treeBlob] };
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });
function streamed(body: unknown, size?: number) {
  const json = Buffer.from(JSON.stringify(body));
  const wire = Buffer.alloc(size ?? json.length, ' ');
  if (json.length > wire.length) throw Error('fixture exceeds response size');
  json.copy(wire);
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === wire.length) return controller.close();
        const end = Math.min(offset + 64_000, wire.length);
        controller.enqueue(wire.subarray(offset, end));
        offset = end;
      },
    }),
  );
}
function treeRequest(
  client: FixedRepositoryGithub,
  endpoint: 'tree' | 'recursive' | 'create',
) {
  return endpoint === 'tree'
    ? client.tree(treeId)
    : endpoint === 'recursive'
      ? client.recursiveTree(treeId)
      : client.createTree(
          treeId,
          'packages/project-runtime/src/command-output.ts',
          '100644',
          'b'.repeat(40),
        );
}
function responseFixture(body: unknown, size?: number) {
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(streamed(body, size));
  const client = new FixedRepositoryGithub(
    async () => ({ token, remainingMs: 30_000 }),
    new AbortController().signal,
    transport,
  );
  return { client, transport };
}
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
  it.each(['tree', 'recursive', 'create'] as const)(
    'accepts an 8,000,000-byte streamed JSON response only for the fixed %s tree endpoint',
    async (endpoint) => {
      const { client, transport } = responseFixture(completeTree, 8_000_000);
      await treeRequest(client, endpoint);
      const [url, init] = transport.mock.calls[0]!;
      expect(String(url)).toBe(
        'https://api.github.com/repos/semiok/allrice/git/trees' +
          (endpoint === 'create'
            ? ''
            : '/' +
              'a'.repeat(40) +
              (endpoint === 'recursive' ? '?recursive=1' : '')),
      );
      expect(init?.method).toBe(endpoint === 'create' ? 'POST' : 'GET');
      if (endpoint === 'create')
        expect(JSON.parse(String(init?.body))).toEqual({
          base_tree: 'a'.repeat(40),
          tree: [
            {
              path: 'packages/project-runtime/src/command-output.ts',
              mode: '100644',
              type: 'blob',
              sha: 'b'.repeat(40),
            },
          ],
        });
    },
  );
  it.each(['tree', 'recursive', 'create'] as const)(
    'rejects a valid streamed JSON response one byte over the %s tree budget',
    async (endpoint) => {
      const { client, transport } = responseFixture(completeTree, 8_000_001);
      await expect(treeRequest(client, endpoint)).rejects.toMatchObject({
        code: 'REPOSITORY_REMOTE_INVALID',
      });
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it('reads all 8192 long UTF-8 blob paths and 2048 directories through the real stream reader', async () => {
    const blobs = Array.from({ length: 8192 }, (_, i) => ({
      ...treeBlob,
      path: `d${i % 2048}/${'雪'.repeat(60)}-${i}.ts`,
      url:
        'https://api.github.com/repos/semiok/allrice/git/blobs/' +
        'b'.repeat(40),
      size: 1,
    }));
    const row = {
      sha: 'a'.repeat(40),
      truncated: false,
      tree: [
        ...Array.from({ length: 2048 }, (_, i) => ({
          path: `d${i}`,
          type: 'tree',
          mode: '040000',
          sha: 'c'.repeat(40),
        })),
        ...blobs,
      ],
    };
    expect(Buffer.byteLength(JSON.stringify(row))).toBeGreaterThan(2_000_000);
    const { client } = responseFixture(row);
    expect(await client.recursiveTree(row.sha)).toEqual(
      blobs.map(({ path, mode, sha }) => ({ path, mode, sha })),
    );
  });
  it.each(['tree', 'recursive', 'create'] as const)(
    'rejects 100001 raw entries before %s projection',
    async (endpoint) => {
      // Compact directory markers isolate the entry-count guard; complete
      // GitHub-shaped directory/path responses are covered by the test above.
      const row = {
        sha: 'a'.repeat(40),
        truncated: false,
        tree: [
          ...Array.from({ length: 100_000 }, () => ({
            type: 'tree',
            mode: '040000',
          })),
          treeBlob,
        ],
      };
      const { client } = responseFixture(row);
      await expect(treeRequest(client, endpoint)).rejects.toMatchObject({
        code: 'REPOSITORY_REMOTE_INVALID',
      });
    },
  );
  it.each([8193, 'truncated'] as const)(
    'refuses a complete-tree response with %s',
    async (boundary) => {
      const { client } = responseFixture({
        sha: 'a'.repeat(40),
        truncated: boundary === 'truncated',
        tree: Array.from(
          { length: boundary === 'truncated' ? 1 : boundary },
          (_, i) => ({
            ...treeBlob,
            path: `f${i}.ts`,
          }),
        ),
      });
      await expect(client.recursiveTree('a'.repeat(40))).rejects.toMatchObject({
        code: 'REPOSITORY_REMOTE_INVALID',
      });
    },
  );
  it('retains the 2 MB ordinary response cap and 100 KB request cap with valid JSON', async () => {
    const row = { id: 1323769790, full_name: 'semiok/allrice' };
    const { client, transport } = responseFixture(row, 2_000_000);
    transport.mockResolvedValueOnce(streamed(row, 2_000_001));
    expect(await client.repository()).toEqual({
      id: row.id,
      fullName: row.full_name,
    });
    await expect(client.repository()).rejects.toMatchObject({
      code: 'REPOSITORY_REMOTE_INVALID',
    });
    await expect(client.createBlob('A'.repeat(100_001))).rejects.toMatchObject({
      code: 'REPOSITORY_REMOTE_INVALID',
    });
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
