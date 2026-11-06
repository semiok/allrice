/* global AbortController, Buffer, Response, URL */
import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { searchCodexWeb } from './allrice-codex-web-search.mjs';
import {
  createWebCallScope,
  requestCancellableWeb,
} from './allrice-web-cancellation.mjs';

afterEach(() => vi.unstubAllGlobals());
const token = `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.fixture`;
const models = (baseUrl) => ({
  getProvider: () => ({ baseUrl }),
  getAuth: async () => ({ auth: { apiKey: token } }),
});

it('keeps the hosted endpoint, auth, limits and uncropped provider summary/source fields', async () => {
  const output = 'summary'.repeat(3000);
  const sources = Array.from({ length: 9 }, (_, i) => ({
    url: `https://source.test/${i}`,
    title: 'title',
    snippet: 'snippet',
    publishedAt: '2026-11-05',
  }));
  const fetcher = vi.fn(
    async () => new Response(JSON.stringify({ output, results: sources })),
  );
  vi.stubGlobal('fetch', fetcher);
  const result = await searchCodexWeb(
    models('https://hosted.test'),
    { query: ' query ', maxResults: 8 },
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    query: 'query',
    output,
    results: sources.slice(0, 8),
    truncated: true,
  });
  const [url, options] = fetcher.mock.calls[0];
  expect(url).toBe('https://hosted.test/codex/alpha/search');
  expect(options.headers).toMatchObject({
    authorization: `Bearer ${token}`,
    'chatgpt-account-id': 'fixture-account',
  });
  expect(JSON.parse(options.body)).toMatchObject({
    max_output_tokens: 4000,
    commands: { search_query: [{ q: 'query' }], response_length: 'medium' },
  });
});

it('retains the service 2 MB limit without a new 12k policy', async () => {
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(
        JSON.stringify({ output: 'x'.repeat(2_000_001), results: [] }),
      ),
  );
  await expect(
    searchCodexWeb(
      models('https://hosted.test'),
      { query: 'q' },
      new AbortController().signal,
    ),
  ).rejects.toThrow('2 MB');
});

it('joins an actual hosted HTTP abort and the original RPC before cancellation returns', async () => {
  let received, closed;
  const started = new Promise((resolve) => {
    received = resolve;
  });
  const socketClosed = new Promise((resolve) => {
    closed = resolve;
  });
  const server = createServer((req, res) => {
    expect(new URL(req.url, 'http://fixture').pathname).toBe(
      '/codex/alpha/search',
    );
    res.on('close', closed);
    received();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const scope = createWebCallScope();
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (method, params) =>
      method === 'cancel'
        ? scope.cancel(params.callId)
        : scope.run(params.callId, (signal) =>
            searchCodexWeb(models(base), params, signal),
          );
    const controller = new AbortController();
    const work = requestCancellableWeb(
      request,
      'search',
      'cancel',
      { callId: 'one', query: 'q' },
      controller.signal,
    );
    const result = work.catch((error) => error);
    await started;
    controller.abort();
    expect(await result).toBeInstanceOf(Error);
    await socketClosed;
    expect(await scope.cancel('one')).toEqual({ settled: true });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
