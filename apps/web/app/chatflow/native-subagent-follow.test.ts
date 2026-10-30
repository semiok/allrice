import { afterEach, describe, expect, it, vi } from 'vitest';
import { followNativeSubagents } from './native-subagent-follow';

afterEach(() => vi.unstubAllGlobals());
const frame = (value: unknown) =>
  new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
describe('safe native follow owned response lifetime', () => {
  it.each([
    ['HTTP', 403, 'text/event-stream'],
    ['Content-Type', 200, 'application/json'],
  ])(
    'cancels the owned body on invalid %s without hiding the read error',
    async (_kind, status, contentType) => {
      const cancel = vi.fn(() => {
        throw Error('cleanup failed');
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(new ReadableStream({ cancel }), {
              status: status as number,
              headers: { 'content-type': contentType as string },
            }),
        ),
      );
      await expect(
        followNativeSubagents(
          '/follow',
          {},
          new AbortController().signal,
          vi.fn(),
        ),
      ).rejects.toThrow('native follow unavailable');
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it.each(['JSON', 'schema', 'owner'])(
    'cancels the reader on %s rejection and preserves the original error',
    async (kind) => {
      const cancel = vi.fn(() => {
        throw Error('cleanup failed');
      });
      const consume = vi.fn(() => {
        if (kind === 'owner') throw Error('owner rejected');
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    kind === 'JSON'
                      ? new TextEncoder().encode('data: broken\n\n')
                      : frame(
                          kind === 'schema'
                            ? { type: 'finished', raw: 'private native frame' }
                            : { type: 'clear', reason: 'resync' },
                        ),
                  );
                },
                cancel,
              }),
              { headers: { 'content-type': 'text/event-stream' } },
            ),
        ),
      );
      await expect(
        followNativeSubagents(
          '/follow',
          {},
          new AbortController().signal,
          consume,
        ),
      ).rejects.toThrow(
        kind === 'owner' ? 'owner rejected' : kind === 'JSON' ? /JSON/ : /type/,
      );
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it('rejects late bytes from a fetch that ignores abort and strips non-whitelisted properties', async () => {
    const abort = new AbortController(),
      consume = vi.fn(),
      cancel = vi.fn();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(value) {
                controller = value;
              },
              cancel,
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
    );
    const reading = followNativeSubagents(
      '/follow',
      { 'x-allrice-workspace-id': 'scope-a' },
      abort.signal,
      consume,
    );
    for (let i = 0; i < 5; i++) await Promise.resolve();
    controller.enqueue(
      frame({
        type: 'clear',
        reason: 'resync',
        raw: 'private',
        credentials: 'secret',
      }),
    );
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(consume).toHaveBeenCalledWith({ type: 'clear', reason: 'resync' });
    abort.abort();
    controller.enqueue(frame({ type: 'clear', reason: 'unavailable' }));
    await reading;
    expect(consume).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
