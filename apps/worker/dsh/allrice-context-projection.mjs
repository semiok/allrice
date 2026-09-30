/** Read DSH's own occupancy projection; never estimate tokens in the host. */
export function nativeContextProjection(ctx, session) {
  const snapshot = ctx.get('sessionProjections')?.snapshot(session);
  const value = snapshot?.values?.contextPressure;
  if (!value)
    return { asOfSeq: snapshot?.asOfSeq ?? null, contextPressure: null };
  const counts = Object.fromEntries(
    ['pressureTokens', 'projectedTokens', 'contextWindow']
      .filter((key) => Number.isInteger(value[key]) && value[key] >= 0)
      .map((key) => [key, value[key]]),
  );
  return { asOfSeq: snapshot.asOfSeq, contextPressure: counts };
}

/** Publish at request/surface boundaries, never once per streamed token. */
export function installNativeContextProjection(ctx, notify) {
  const boundaries = new Set([
    'request/context',
    'tool/result',
    'assistant/message',
    'compaction/start',
    'compaction/end',
  ]);
  return ctx.on('session/event', (session, event) => {
    if (!boundaries.has(event.type)) return;
    try {
      const projection = nativeContextProjection(ctx, session);
      if (!projection.contextPressure?.contextWindow) return;
      notify('session.context', {
        sessionId: String(session.id),
        ...projection,
      });
    } catch {
      // Optional UI telemetry must not interrupt an otherwise valid turn.
    }
  });
}
