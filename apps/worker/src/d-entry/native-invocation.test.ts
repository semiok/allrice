import { describe, expect, it, vi } from 'vitest';
import {
  authorizeDEntryNativeInvocation,
  createDEntryMuxGate,
} from './native-invocation.js';

const signal = new AbortController().signal;
const root = 'dsh-root',
  child = 'dsh-child';
function source() {
  return vi.fn(async (id: string) => ({
    nativeSessionId: id,
    rootNativeSessionId: root,
    parentNativeSessionId: id === root ? null : root,
    bindingRef: 'exact-owner',
  }));
}
const prompt = (sessionId: string) => ({
  args: {
    request: {
      requestId: 'browser-prompt',
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'hello' }],
    },
  },
});
const follow = (sessionId: string) => ({
  args: {
    request: {
      address: { kind: 'session', sessionId },
    },
  },
});

describe('rc.2 generated Remote gate for browser invocations', () => {
  it('allows an authorized root prompt with its native identity intact', async () => {
    const authorize = source(),
      payload = prompt(root);
    const accepted = await authorizeDEntryNativeInvocation(
      authorize,
      'session/prompt',
      payload,
      'http',
      signal,
    );
    expect(accepted.payload).toEqual(payload);
    expect(authorize).toHaveBeenCalledWith(root, 'write', signal);
  });

  it('rejects child prompt, cancel, rename and queue edits, including a continuable child', async () => {
    for (const [endpoint, request] of [
      ['session/prompt', prompt(child).args.request],
      ['session/cancel', { sessionId: child }],
      ['session/rename', { sessionId: child, title: 'edited' }],
      [
        'session/updateQueue',
        { sessionId: child, itemId: 'message', action: { kind: 'steer' } },
      ],
    ] as const) {
      const authorize = source();
      await expect(
        authorizeDEntryNativeInvocation(
          authorize,
          endpoint,
          { args: { request } },
          'http',
          signal,
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect(authorize).toHaveBeenCalledWith(child, 'write', signal);
    }
  });

  it('uses generated strict nested codecs before current resource lookup', async () => {
    const authorize = source();
    await expect(
      authorizeDEntryNativeInvocation(
        authorize,
        'session/prompt',
        {
          args: {
            request: {
              ...prompt(root).args.request,
              trustedRoot: root,
            },
          },
        },
        'http',
        signal,
      ),
    ).rejects.toThrow();
    expect(authorize).not.toHaveBeenCalled();
  });

  it('rejects unknown, global, event-answer and fork operations without dispatch', async () => {
    const authorize = source();
    for (const endpoint of [
      'session/continue',
      'session/send',
      'session/edit',
      'session/list',
      'session/control',
      'session/create',
      'session/fork',
      '$events',
      '$events/result',
    ]) {
      await expect(
        authorizeDEntryNativeInvocation(
          authorize,
          endpoint,
          { args: {} },
          'http',
          signal,
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    }
    expect(authorize).not.toHaveBeenCalled();
  });

  it('requires the catalog parent for a subagent history address', async () => {
    const payload = {
      args: {
        request: {
          address: {
            kind: 'subagent',
            parentSessionId: 'dsh-other',
            childSessionId: child,
            mode: 'continuable',
          },
        },
      },
    };
    await expect(
      authorizeDEntryNativeInvocation(
        source(),
        'session/follow',
        payload,
        'mux',
        signal,
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    payload.args.request.address.parentSessionId = root;
    await expect(
      authorizeDEntryNativeInvocation(
        source(),
        'session/follow',
        payload,
        'mux',
        signal,
      ),
    ).resolves.toMatchObject({ resource: { nativeSessionId: child } });
  });

  it('gates every Mux open; no opaque stream can send a prompt or arbitrary uplink', async () => {
    const authorize = source(),
      gate = createDEntryMuxGate(authorize);
    await expect(
      gate.accept(
        JSON.stringify({
          type: 'open',
          streamId: 'a',
          endpoint: 'session/prompt',
          payload: prompt(child),
        }),
        signal,
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await gate.accept(
      JSON.stringify({
        type: 'open',
        streamId: 'b',
        endpoint: 'session/follow',
        payload: follow(child),
      }),
      signal,
    );
    await expect(
      gate.accept(
        JSON.stringify({ type: 'item', streamId: 'b', value: prompt(child) }),
        signal,
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      gate.accept(
        JSON.stringify({ type: 'cancel', streamId: 'unknown' }),
        signal,
      ),
    ).resolves.toBeNull();
    await gate.accept(
      JSON.stringify({ type: 'cancel', streamId: 'b' }),
      signal,
    );
  });

  it('drops terminal/cancel tails without authorizing or disturbing another stream', async () => {
    const authorize = source(),
      gate = createDEntryMuxGate(authorize);
    for (const streamId of ['finished', 'live'])
      await gate.accept(
        JSON.stringify({
          type: 'open',
          streamId,
          endpoint: 'session/follow',
          payload: follow(child),
        }),
        signal,
      );
    gate.ended('finished');
    authorize.mockClear();
    for (const type of ['cancel', 'end'])
      expect(
        await gate.accept(
          JSON.stringify({ type, streamId: 'finished' }),
          signal,
        ),
      ).toBeNull();
    expect(authorize).not.toHaveBeenCalled();
    await gate.authorizeFrame('live', signal);
    expect(authorize).toHaveBeenCalledWith(child, 'read', signal);
    await expect(
      gate.accept(
        JSON.stringify({ type: 'item', streamId: 'finished', value: {} }),
        signal,
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
  });

  it('rechecks current authority before each server frame and never swallows revocation', async () => {
    const authorize = source(),
      gate = createDEntryMuxGate(authorize);
    await gate.accept(
      JSON.stringify({
        type: 'open',
        streamId: 'b',
        endpoint: 'session/follow',
        payload: follow(child),
      }),
      signal,
    );
    const revoked = new Error('revoked');
    authorize.mockRejectedValueOnce(revoked);
    await expect(gate.authorizeFrame('b', signal)).rejects.toBe(revoked);
    const abort = new AbortController();
    abort.abort(revoked);
    await expect(
      gate.accept(
        JSON.stringify({ type: 'cancel', streamId: 'b' }),
        abort.signal,
      ),
    ).rejects.toBe(revoked);
  });
});
