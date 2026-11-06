/* global AbortController */
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Web from '@deepseek-ai/dsh-web';
import * as Timeout from '@deepseek-ai/dsh-tool-call-timeout-policy';
import * as NativeWeb from '@deepseek-ai/dsh-tool-web';
import { afterEach, expect, it, vi } from 'vitest';
import { installNativeWeb } from './allrice-native-web.mjs';
import {
  createWebCallScope,
  requestCancellableWeb,
} from './allrice-web-cancellation.mjs';

const contexts = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
});
async function fixture(broker, enabled = ['web.search', 'web.fetch']) {
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  await ctx.plugin(Web, {});
  await ctx.plugin(Timeout);
  installNativeWeb(ctx, broker)(new Set(enabled));
  return {
    ctx,
    call: (
      name,
      args,
      id = 'call',
      agent = 'root',
      signal = new AbortController().signal,
    ) =>
      ctx.tools.execute({
        name,
        arguments: args,
        callId: id,
        agent: { id: agent },
        signal,
      }),
  };
}
const text = (result) =>
  result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');
const reply = (value) => ({
  modelContent: JSON.stringify(value),
  summary: 'fixture',
});

it('uses upstream schemas, guidance and budgets; only the frozen tools are registered', async () => {
  const f = await fixture(vi.fn(), ['web.fetch']);
  const upstream = new Context();
  contexts.push(upstream);
  await upstream.plugin(SystemPrompt);
  await upstream.plugin(Tools);
  await upstream.plugin(Web, {});
  await upstream.plugin(NativeWeb, {
    search: false,
    fetchMaxOutputChars: 12000,
  });
  expect(f.ctx.tools.schemas()).toEqual(upstream.tools.schemas());
  expect(f.ctx.tools.get('web_fetch').timeoutMs).toBe(30000);
  expect(f.ctx.tools.get('web_search')).toBeUndefined();
});

it('keeps >12k search summaries/snippets intact; native count cap and renderer own the output', async () => {
  const source = {
    url: 'https://source.test',
    title: 'Title',
    snippet: 'S'.repeat(14000),
    publishedAt: '2026-11-05',
  };
  const value = {
    content: 'C'.repeat(16000),
    sources: [source],
    truncated: false,
  };
  const broker = vi.fn(async () => reply(value));
  const f = await fixture(broker);
  const result = await f.call('web_search', { queries: ['query'] });
  expect(result.isError).toBe(false);
  expect(text(result)).toBe(NativeWeb.formatSearchOutput(value));
  expect(result.value).toEqual(value);
  expect(text(result)).not.toContain('bounded_tool_result');
  expect(broker.mock.calls[0][0]).toEqual({
    nativeSessionId: 'root',
    toolCallId: 'call:0',
    name: 'web.search',
    arguments: { query: 'query', maxResults: 8 },
  });
});

it('lets native fetch cap the complete output at 12k and report truncation/status', async () => {
  const value = {
    url: 'https://source.test',
    statusCode: 404,
    body: { kind: 'text', content: 'x'.repeat(20000) },
    truncated: false,
  };
  const f = await fixture(async () => reply(value));
  const result = await f.call('web_fetch', { url: value.url });
  expect(result.isError).toBe(false);
  expect(text(result)).toBe(NativeWeb.formatFetchOutput(value, 12000));
  expect(text(result).length).toBeLessThanOrEqual(12000);
  expect(NativeWeb.fetchMetaFromResult(result).truncated).toBe(true);
  expect(text(result)).toContain('HTTP 404');
});

it('keeps concurrent root, child, fork and resumed call attribution separate', async () => {
  const calls = [];
  const f = await fixture(async (params) => {
    await Promise.resolve();
    calls.push(params);
    return reply({
      content: params.nativeSessionId,
      sources: [],
      truncated: false,
    });
  });
  const identities = ['root', 'child', 'fork', 'resumed-root'];
  const results = await Promise.all(
    identities.map((id) =>
      f.call('web_search', { queries: ['a', 'b'] }, 'same-call', id),
    ),
  );
  expect(results.every((r) => !r.isError)).toBe(true);
  expect(calls).toHaveLength(8);
  for (const id of identities)
    expect(
      calls.filter((c) => c.nativeSessionId === id).map((c) => c.toolCallId),
    ).toEqual(['same-call:0', 'same-call:1']);
  await expect(f.ctx.web.search({ query: 'unbound' })).rejects.toThrow(
    'WEB_CALL_SCOPE_REQUIRED',
  );
});

it('native timeout propagates over RPC and joins actual cleanup before settling', async () => {
  const scope = createWebCallScope();
  let release,
    started,
    canceled = false,
    settled = false;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const cleanup = new Promise((resolve) => {
    release = resolve;
  });
  const request = (method, params) =>
    method === 'cancel'
      ? scope.cancel(params.toolCallId)
      : scope.run(params.toolCallId, async (signal) => {
          started();
          await new Promise((resolve) =>
            signal.addEventListener('abort', resolve, { once: true }),
          );
          canceled = true;
          await cleanup;
          signal.throwIfAborted();
        });
  const f = await fixture((params, signal) =>
    requestCancellableWeb(request, 'call', 'cancel', params, signal),
  );
  vi.useFakeTimers();
  const result = f
    .call('web_fetch', { url: 'https://slow.test' })
    .then((value) => {
      settled = true;
      return value;
    });
  await ready;
  await vi.advanceTimersByTimeAsync(30001);
  expect(canceled).toBe(true);
  expect(settled).toBe(false);
  release();
  expect((await result).error.info.code).toBe('TOOL_TIMEOUT');
});

it('one failed query cancels and joins the other query before native search returns', async () => {
  let release,
    started,
    canceled = false,
    settled = false;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const cleanup = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(async (params, signal) => {
    if (params.arguments.query === 'fail') {
      await ready;
      throw Error('service failure');
    }
    started();
    await new Promise((resolve) =>
      signal.addEventListener('abort', resolve, { once: true }),
    );
    canceled = true;
    await cleanup;
    signal.throwIfAborted();
  });
  const result = f
    .call('web_search', { queries: ['fail', 'wait'] })
    .then((value) => {
      settled = true;
      return value;
    });
  await vi.waitFor(() => expect(canceled).toBe(true));
  expect(settled).toBe(false);
  release();
  expect((await result).isError).toBe(true);
});

it('cancellation cannot end another active request, and duplicate active IDs are refused', async () => {
  const scope = createWebCallScope();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const call = scope.run('root/call', async (signal) => {
    await gate;
    return signal.aborted;
  });
  expect(() => scope.run('root/call', async () => {})).toThrow(
    'WEB_CALL_ALREADY_ACTIVE',
  );
  await scope.cancel('other/call');
  release();
  expect(await call).toBe(false);
});
