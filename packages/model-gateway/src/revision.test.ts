import { afterEach, describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmError,
  createUserMessage,
} from '@deepseek-ai/dsh-llm';
import type { StreamChunk, ImageBlock } from '@deepseek-ai/dsh-llm';
import * as ImageOffload from '@deepseek-ai/dsh-compaction-image-offload';
import type { GatewayProvider } from './contract.ts';
import {
  gatewayFixture,
  nativeFailure,
  upstreamFixture,
} from './gateway.fixture.ts';
import { nativeRefreshFixture, responsesFixture } from './revision.fixture.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const finish = (chunks: StreamChunk[]) =>
  chunks.findLast((chunk) => chunk.type === 'finish');

describe.sequential(
  'MET268 R1: native behavior through the real HTTP gateway',
  () => {
    it('未接凭据事务owner的refresh在任何实际外发前拒绝', async () => {
      const upstream = await upstreamFixture();
      cleanup.push(() => upstream.close());
      const provider: GatewayProvider = {
        classify() {
          return { kind: 'auth-refresh', protocol: 'opaque' };
        },
        async *stream() {
          await fetch(upstream.url + '/refresh', {
            signal: AbortSignal.timeout(15_000),
          });
          yield nativeFailure('UNREACHABLE');
        },
      };
      const f = await gatewayFixture({ provider });
      cleanup.push(() => f.close());
      expect(finish(await f.collect())).toMatchObject({
        reason: {
          kind: 'error',
          failure: { code: 'AUTH_TRANSACTION_REQUIRED' },
        },
      });
      expect(upstream.requests).toHaveLength(0);
      expect(f.store.rows.size).toBe(0);
    });

    it.each(['client', 'revoke', 'close'] as const)(
      '%s取消不打断已轮换token的原生刷新，close等到持锁落盘且不派发模型',
      async (action) => {
        const auth = await nativeRefreshFixture();
        cleanup.push(() => auth.close());
        const f = await gatewayFixture({ provider: auth.provider });
        cleanup.push(async () => {
          auth.releaseResponse();
          auth.allowSave();
          await f.close();
        });
        const installedFetch = globalThis.fetch;
        const controller = new AbortController();
        const collecting = f
          .collect(f.input(controller.signal))
          .catch((error) => error);
        await auth.arrived;
        expect(auth.rotated).toBe(true);
        expect(f.admission.observe(f.binding.vm)).toMatchObject({
          active: 1,
          queued: 0,
        });
        let revoked: Promise<void> | undefined;
        if (action === 'client') {
          controller.abort(new Error('synthetic browser cancellation'));
          await collecting;
        } else if (action === 'revoke')
          revoked = f.gateway.revoke(f.binding.vm);
        let closed = false;
        const closing = f.gateway.close().then(() => {
          closed = true;
        });
        await Promise.resolve();
        expect(closed).toBe(false);
        expect(auth.refreshSignal?.aborted).toBe(false);
        expect(globalThis.fetch).toBe(installedFetch);
        auth.releaseResponse();
        await auth.readyToSave;
        // HTTP has completed, but the native credentials-local mutation is still
        // holding its writer lock. Waiting only for the HTTP receipt is too early.
        expect(closed).toBe(false);
        expect(globalThis.fetch).toBe(installedFetch);
        expect(f.admission.finished).toHaveLength(0);
        expect(f.admission.records.size).toBe(1);
        expect(await auth.persisted()).toMatchObject({
          payload: { refresh: 'synthetic-expired-refresh' },
        });
        auth.allowSave();
        await Promise.all([closing, collecting, revoked]);
        expect(f.admission.records.size).toBe(0);
        expect(f.admission.finished).toHaveLength(1);
        expect(await auth.persisted()).toMatchObject({
          payload: {
            access: 'synthetic-rotated-access',
            refresh: 'synthetic-rotated-refresh',
          },
        });
        expect(auth.upstream.requests).toHaveLength(0);
        expect(auth.requestCount).toBe(1);
        const rows = [...f.store.rows.values()];
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          callId: [...f.store.calls.keys()][0],
          personId: f.binding.vm.personId,
          kind: 'auth-refresh',
          dispatchObserved: true,
          httpStatus: 200,
          outcome: 'closed',
          terminal: null,
          usage: {
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            usageComplete: false,
          },
        });
        expect(f.store.slots.get(f.binding.vm.personId)?.size ?? 0).toBe(0);
        expect(f.errors).toEqual([]);
      },
    );

    it.each([
      {
        codex: false,
        terminal: 'max_output_tokens' as const,
        tools: false,
        kind: 'max-tokens',
      },
      {
        codex: true,
        terminal: 'completed' as const,
        tools: false,
        kind: 'stop',
      },
      {
        codex: true,
        terminal: 'completed' as const,
        tools: true,
        kind: 'tool-calls',
      },
    ])('保留原生Responses终止 $kind (Codex=$codex)', async (options) => {
      const native = await responsesFixture(options);
      cleanup.push(() => native.close());
      const f = await gatewayFixture({
        provider: native.provider,
        binding: native.binding,
      });
      cleanup.push(() => f.close());
      const chunks = await f.collect();
      expect(finish(chunks)).toMatchObject({ reason: { kind: options.kind } });
      expect(
        chunks
          .filter((c) => c.type === 'text-delta')
          .map((c) => c.text)
          .join(''),
      ).toBe('Synthetic response');
      if (options.tools)
        expect(
          chunks.some(
            (c) => c.type === 'tool-call-delta' && c.name === 'lookup',
          ),
        ).toBe(true);
      expect(native.requests).toHaveLength(1);
      expect([...f.store.rows.values()]).toMatchObject([
        {
          terminal:
            options.terminal === 'max_output_tokens'
              ? 'incomplete'
              : 'completed',
          ...(options.terminal === 'max_output_tokens'
            ? { terminalReason: 'max_output_tokens' }
            : {}),
          usage: {
            inputTokens: 12,
            outputTokens: 3,
            totalTokens: 15,
            cachedInputTokens: 4,
          },
        },
      ]);
    });

    it.each(['content_filter', 'failed', 'missing'] as const)(
      'Responses %s保持失败，不将任意incomplete/缺帧放行为成功',
      async (terminal) => {
        const native = await responsesFixture({ terminal });
        cleanup.push(() => native.close());
        const f = await gatewayFixture({ provider: native.provider });
        cleanup.push(() => f.close());
        expect(finish(await f.collect())).toMatchObject({
          reason: { kind: 'error' },
        });
        const row = [...f.store.rows.values()][0]!;
        expect(row.terminal).toBe(
          terminal === 'content_filter'
            ? 'incomplete'
            : terminal === 'failed'
              ? 'failed'
              : null,
        );
        expect(f.store.slots.get(f.binding.vm.personId)?.size).toBe(0);
      },
    );

    it('失败帧带usage且body保持打开：原生abort真实关闭并保留事实，8次失败后第9路成功', async () => {
      const native = await responsesFixture({
        holdFailedBody: true,
        failuresBeforeSuccess: 8,
      });
      cleanup.push(() => native.close());
      const f = await gatewayFixture({
        provider: native.provider,
        binding: native.binding,
      });
      cleanup.push(() => f.close());
      for (let index = 0; index < 8; index++) {
        expect(finish(await f.collect())).toMatchObject({
          reason: { kind: 'error' },
        });
        await native.whenClosed(index + 1);
        expect(native.active).toBe(0);
        expect([...f.store.rows.values()][index]).toMatchObject({
          dispatchObserved: true,
          httpStatus: 200,
          terminal: 'failed',
          usage: {
            inputTokens: 12,
            outputTokens: 3,
            totalTokens: 15,
            cachedInputTokens: 4,
          },
        });
        expect(f.store.slots.get(f.binding.vm.personId)?.size).toBe(0);
      }
      expect(finish(await f.collect())).toMatchObject({
        reason: { kind: 'stop' },
      });
      await native.whenClosed(9);
      expect(native.requests).toHaveLength(9);
      expect(f.store.slots.get(f.binding.vm.personId)?.size).toBe(0);
    });

    it('真正关闭未知仍保留slot，但不丢已观察的HTTP/failed/usage事实', async () => {
      const endpoint = 'http://synthetic-unclosed.invalid/v1/stream';
      const original = globalThis.fetch;
      let transportActive = true;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: ' +
                JSON.stringify({
                  type: 'response.failed',
                  response: {
                    status: 'failed',
                    usage: {
                      input_tokens: 12,
                      output_tokens: 3,
                      total_tokens: 15,
                      input_tokens_details: { cached_tokens: 4 },
                    },
                  },
                }) +
                '\n\n',
            ),
          );
        },
        cancel() {
          throw new Error('synthetic underlying transport still active');
        },
      });
      // A hostile/unknown transport counterexample, not an actual network call.
      // Its errored reader cannot prove that the underlying resource stopped.
      globalThis.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        return url === endpoint
          ? Promise.resolve(new Response(body, { status: 200 }))
          : original(input, init);
      };
      cleanup.push(async () => {
        transportActive = false;
        globalThis.fetch = original;
      });
      const provider: GatewayProvider = {
        classify(input) {
          return String(input) === endpoint
            ? { kind: 'model', protocol: 'openai-responses' }
            : null;
        },
        async *stream(_binding, _input, signal) {
          const response = await fetch(endpoint, { method: 'POST', signal });
          const reader = response.body!.getReader();
          await reader.read();
          await reader.cancel();
          yield nativeFailure('UNREACHABLE');
        },
      };
      const f = await gatewayFixture({ provider });
      cleanup.push(() => f.close());
      expect(finish(await f.collect())).toMatchObject({
        reason: { kind: 'error' },
      });
      expect(transportActive).toBe(true);
      expect(f.store.slots.get(f.binding.vm.personId)?.size).toBe(1);
      expect(f.admission.records.size).toBe(1);
      expect(f.admission.finished).toHaveLength(0);
      expect([...f.admission.records.values()][0]!.pending.size).toBe(0);
      expect([...f.store.rows.values()]).toMatchObject([
        {
          dispatchObserved: true,
          httpStatus: 200,
          terminal: 'failed',
          outcome: 'unknown',
          usage: {
            inputTokens: 12,
            outputTokens: 3,
            totalTokens: 15,
            cachedInputTokens: 4,
          },
        },
      ]);
    });

    it('已dispatch的fetch拒绝但无独立close事实：不把Promise拒绝当真实join', async () => {
      const endpoint = 'http://synthetic-fetch-unclosed.invalid/v1/stream';
      const original = globalThis.fetch;
      // A synthetic counterexample, not a real socket or a claim of native
      // behavior: the transport rejects while its underlying resource is unknown.
      globalThis.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        return url === endpoint
          ? Promise.reject(
              new Error('synthetic fetch rejected without close proof'),
            )
          : original(input, init);
      };
      cleanup.push(async () => {
        globalThis.fetch = original;
      });
      const provider: GatewayProvider = {
        classify(input) {
          return String(input) === endpoint
            ? { kind: 'model', protocol: 'opaque' }
            : null;
        },
        async *stream(_binding, _input, signal) {
          await fetch(endpoint, { method: 'POST', signal });
          yield nativeFailure('UNREACHABLE');
        },
      };
      const f = await gatewayFixture({ provider });
      cleanup.push(() => f.close());
      expect(finish(await f.collect())).toMatchObject({
        reason: { kind: 'error' },
      });
      expect([...f.store.rows.values()]).toMatchObject([
        {
          dispatchObserved: true,
          httpStatus: null,
          outcome: 'unknown',
          usage: { totalTokens: null },
        },
      ]);
      expect(f.store.slots.get(f.binding.vm.personId)?.size).toBe(1);
      expect(f.admission.records.size).toBe(1);
      expect(f.admission.finished).toHaveLength(0);
      expect([...f.admission.records.values()][0]!.pending.size).toBe(0);
    });

    it('HTTP错误保留offloadImages，原生compaction-image-offload仍记录卸载并返回retry', async () => {
      const provider: GatewayProvider = {
        classify() {
          return null;
        },
        async *stream() {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: new LlmError(
                'Synthetic image bound',
                IMAGE_OFFLOAD_REQUIRED_CODE,
                { offloadImages: 1 },
              ).failure,
            },
          };
        },
      };
      const f = await gatewayFixture({ provider });
      cleanup.push(() => f.close());
      const terminal = finish(await f.collect());
      expect(terminal).toMatchObject({
        reason: {
          kind: 'error',
          failure: { code: IMAGE_OFFLOAD_REQUIRED_CODE, offloadImages: 1 },
        },
      });
      if (!terminal || terminal.reason.kind !== 'error')
        throw new Error('Expected native failure');
      // Call the public plugin's real listener with the HTTP-decoded failure.
      // The session/event storage below is only a deterministic test owner.
      const message = createUserMessage({
        source: { kind: 'user' },
        content: [
          {
            type: 'image',
            attachment: {
              attachmentId:
                'synthetic-image' as ImageBlock['attachment']['attachmentId'],
              mediaType: 'image/png',
              bytes: 1,
              width: 1,
              height: 1,
            },
          },
        ],
      });
      const events: { type: string; data: unknown }[] = [];
      const session = {
        surface: { nodes: [0] },
        eventAt() {
          return { type: 'user/message', data: message };
        },
        deriveEventMessage() {
          return message;
        },
        append(type: string, data: unknown) {
          events.push({ type, data });
        },
      };
      const ctx = new Context();
      cleanup.push(() => ctx.fiber.dispose());
      Object.assign(ctx, { sessions: { registerMessageProjection() {} } });
      ImageOffload.apply(ctx);
      const recovery = await ctx.events.waterfall(
        'agent/request-error',
        {
          agent: { session },
          failure: terminal.reason.failure,
          signal: new AbortController().signal,
        },
        () => Promise.resolve({ kind: 'unhandled' } as const),
      );
      expect(recovery).toEqual({ kind: 'retry' });
      expect(events).toEqual([
        {
          type: 'image/offload',
          data: { targets: [{ seq: 0, imageIndexes: [0] }] },
        },
      ]);
    });
  },
);
