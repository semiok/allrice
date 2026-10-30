import { randomUUID } from 'node:crypto';
import { hasModelOutput, settledTokenUsage } from './allrice-model-usage.mjs';

/** Public stream observations, not execution permission or Session totals. */
export function installNativeAccounting(ctx, bridge, attribute) {
  const pending = new Set();
  let root,
    calls = 0,
    complete = true;
  async function send(params, signal) {
    try {
      await bridge(params, signal);
    } catch {
      complete = false;
      ctx.logger.warn('Native model receipt delivery incomplete');
    }
  }
  ctx.on(
    'llm/stream',
    async function* (options, next) {
      const scope = attribute({ nativeSessionId: options.sessionId });
      const identity = {
        callId: randomUUID(),
        nativeSessionId: options.sessionId,
        provider: options.provider,
        model: options.model,
        ...(options.purpose ? { purpose: options.purpose } : {}),
      };
      calls++;
      let release;
      const done = new Promise((resolve) => {
        release = resolve;
      });
      pending.add(done);
      let usage,
        reason,
        observedOutput = false;
      try {
        // The existing model authorization runs AFTER this potentially slow RPC.
        await send(
          { ...scope, fact: { ...identity, phase: 'start' } },
          options.signal,
        );
        for await (const chunk of next()) {
          if (chunk.type === 'usage') usage = chunk.usage;
          if (chunk.type === 'finish') reason = chunk.reason?.kind;
          observedOutput ||= hasModelOutput(chunk);
          yield chunk;
        }
      } finally {
        const settled = settledTokenUsage(usage ?? {}, observedOutput);
        const exactTotal =
          Number.isSafeInteger(usage?.totalTokens) &&
          usage.totalTokens === settled.inputTokens + settled.outputTokens;
        const raw = Object.fromEntries(
          [
            'inputTokens',
            'cacheReadTokens',
            'cacheWriteTokens',
            'outputTokens',
            'totalTokens',
          ]
            .filter(
              (key) => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0,
            )
            .map((key) => [key, usage[key]]),
        );
        if (exactTotal)
          for (const key of ['cacheReadTokens', 'cacheWriteTokens'])
            if (usage[key] === undefined) raw[key] = 0;
        const outcome = ['stop', 'tool-calls', 'max-tokens'].includes(reason)
          ? 'succeeded'
          : reason === 'aborted'
            ? 'canceled'
            : reason
              ? 'failed'
              : 'incomplete';
        await send({
          ...scope,
          fact: {
            ...identity,
            phase: 'finish',
            outcome,
            usage: raw,
            usageComplete:
              outcome !== 'incomplete' &&
              (usage?.totalTokens === undefined || exactTotal) &&
              [
                'inputTokens',
                'cacheReadTokens',
                'cacheWriteTokens',
                'outputTokens',
              ].every((key) => raw[key] !== undefined) &&
              settled.inputTokens !== undefined &&
              settled.outputTokens !== undefined,
          },
        });
        pending.delete(done);
        release();
      }
    },
    { prepend: true },
  );
  return {
    begin(sessionId) {
      if (pending.size) throw Error('NATIVE_ACCOUNTING_NOT_DRAINED');
      root = attribute({ nativeSessionId: sessionId });
      calls = 0;
      complete = true;
    },
    async flush() {
      // Include entire observed iterators, even when no RPC is currently pending.
      while (pending.size) await Promise.all([...pending]);
      if (root) await send({ ...root, delivery: { calls, complete } });
    },
  };
}
