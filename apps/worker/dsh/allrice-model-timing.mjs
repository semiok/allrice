import { performance } from 'node:perf_hooks';

// Observe-only, bounded metadata. Never await logging or let a logger failure
// affect model admission, streaming, settlement, cancellation or native retry.
export function createModelTiming({
  startedMono,
  startedAt,
  preparationMs,
  ledgerPreparationMs,
  emit,
}) {
  const phases = new Set();
  const fields = {
    version: 1,
    startedAt,
    preparationMs,
    ledgerPreparationMs,
    authorizationReadMs: null,
    firstChunkMs: null,
    firstContentMs: null,
    firstTextMs: null,
    firstReasoningMs: null,
    firstToolCallMs: null,
  };
  const elapsed = () =>
    Math.max(0, Math.round(performance.now() - startedMono));
  let transport;
  function notify(phase, extra = {}) {
    if (phases.has(phase)) return;
    phases.add(phase);
    try {
      const value = {
        ...fields,
        ...extra,
        phase,
        elapsedMs: elapsed(),
        ...(transport?.timing() ?? {
          transport: 'unobserved',
          requestCount: 0,
          websocketRequests: 0,
          requestsTruncated: false,
          httpRequests: [],
        }),
      };
      Promise.resolve(emit?.(value)).catch(() => {});
    } catch {
      /* Logging is not an execution or retry authority. */
    }
  }
  return {
    prepared: () => notify('prepared'),
    dispatched(value, metadata) {
      transport = value;
      Object.assign(fields, metadata);
    },
    wait() {
      notify('waiting');
    },
    chunk(chunk, hasOutput) {
      fields.firstChunkMs ??= elapsed();
      if (!hasOutput) return;
      if (chunk.type === 'text-delta') fields.firstTextMs ??= elapsed();
      if (chunk.type === 'reasoning-delta')
        fields.firstReasoningMs ??= elapsed();
      if (chunk.type === 'tool-call-delta' || chunk.blockType === 'tool-call')
        fields.firstToolCallMs ??= elapsed();
      if (fields.firstContentMs === null) {
        fields.firstContentMs = elapsed();
        notify('first_content');
      }
    },
    finished({ failed, stopKind, settlementMs, settlementConfirmed }) {
      notify(failed ? 'failed' : 'completed', {
        stopKind,
        settlementMs,
        settlementConfirmed,
      });
    },
  };
}
