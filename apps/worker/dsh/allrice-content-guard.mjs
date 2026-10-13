// A public DSH middleware, independent of assistants and the native loop.
// Native compaction and bounded retries also traverse llm/stream. Nothing is
// sent if Worker has released this Run, lost its lease or revoked its context.
export function installContentGuard(ctx, bridge) {
  return ctx.on('llm/stream', async function* (options, next) {
    if (!options.sessionId || options.signal?.aborted)
      throw Error('employee_content_dispatch_unavailable');
    await bridge({ nativeSessionId: options.sessionId }, options.signal);
    yield* next();
  });
}
