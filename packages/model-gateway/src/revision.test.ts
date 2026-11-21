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
        expect(await auth.persisted()).toMatchObject({
          payload: { refresh: 'synthetic-expired-refresh' },
        });
        auth.allowSave();
        await Promise.all([closing, collecting, revoked]);
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
        if (terminal === 'failed') {
          // Native error unwind can abort fetch before reader.cancel confirms
          // closure. Preserve that unknown intent/lease rather than inventing
          // a closed receipt merely because the provider returned an error.
          expect(['failed', null]).toContain(row.terminal);
          if (row.terminal === null) expect(row.outcome).toBe('unknown');
        } else
          expect(row.terminal).toBe(
            terminal === 'content_filter' ? 'incomplete' : null,
          );
      },
    );

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
