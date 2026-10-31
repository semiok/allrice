import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { followNativeSubagents } from './native-subagent-follow';

class Socket {
  static instances: Socket[] = [];
  binaryType = '';
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  close = vi.fn();
  constructor(readonly url: URL) {
    Socket.instances.push(this);
  }
  frame(value: string) {
    this.onmessage?.({
      data: new TextEncoder().encode(value).buffer,
    } as MessageEvent);
  }
}
const headers = {
  'x-allrice-organization-id': 'org',
  'x-allrice-workspace-id': 'workspace',
};
const url =
  '/api/v1/sessions/parent/subagents?workspaceId=workspace&follow=true';
beforeEach(() => {
  Socket.instances = [];
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('location', new URL('https://allrice.example/chatflow'));
});
afterEach(() => vi.unstubAllGlobals());
describe('authorized native follow socket ownership', () => {
  it.each(['error', 'abnormal close'])(
    'rejects %s and closes its transport',
    async (kind) => {
      const reading = followNativeSubagents(
        url,
        headers,
        new AbortController().signal,
        vi.fn(),
      );
      const socket = Socket.instances[0]!;
      if (kind === 'error') socket.onerror?.();
      else socket.onclose?.({ code: 1006 } as CloseEvent);
      await expect(reading).rejects.toThrow('native follow unavailable');
      expect(socket.close).toHaveBeenCalledOnce();
    },
  );
  it.each(['JSON', 'schema', 'owner'])(
    'closes on %s rejection and preserves the error',
    async (kind) => {
      const consume = vi.fn(() => {
        if (kind === 'owner') throw Error('owner rejected');
      });
      const reading = followNativeSubagents(
        url,
        headers,
        new AbortController().signal,
        consume,
      );
      const socket = Socket.instances[0]!;
      socket.frame(
        `data: ${
          kind === 'JSON'
            ? 'broken'
            : JSON.stringify(
                kind === 'schema'
                  ? { type: 'finished', raw: 'private' }
                  : { type: 'clear', reason: 'resync' },
              )
        }\n\n`,
      );
      await expect(reading).rejects.toThrow(
        kind === 'owner' ? 'owner rejected' : kind === 'JSON' ? /JSON/ : /type/,
      );
      expect(socket.close).toHaveBeenCalledOnce();
    },
  );
  it('keeps fragmented SSE parsing, strips private fields and rejects late bytes after abort', async () => {
    const abort = new AbortController(),
      consume = vi.fn();
    const reading = followNativeSubagents(url, headers, abort.signal, consume);
    const socket = Socket.instances[0]!;
    expect(String(socket.url)).toBe(
      'wss://allrice.example' + url + '&organizationId=org',
    );
    socket.frame('data: {"type":"clear",');
    socket.frame('"reason":"resync","credentials":"private"}\n\n');
    expect(consume).toHaveBeenCalledWith({ type: 'clear', reason: 'resync' });
    const late = socket.onmessage;
    abort.abort();
    late?.({
      data: new TextEncoder().encode(
        'data: {"type":"clear","reason":"unavailable"}\n\n',
      ).buffer,
    } as MessageEvent);
    await reading;
    expect(consume).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledOnce();
  });
  it('resolves a normal upstream end and does not open an already-aborted observation', async () => {
    const abort = new AbortController();
    const reading = followNativeSubagents(url, headers, abort.signal, vi.fn());
    Socket.instances[0]!.onclose?.({ code: 1000 } as CloseEvent);
    await reading;
    abort.abort();
    await followNativeSubagents(url, headers, abort.signal, vi.fn());
    expect(Socket.instances).toHaveLength(1);
  });
  it.each([
    'https://other.example' + url,
    url.replace('workspaceId=workspace', 'workspaceId=other'),
  ])('refuses scope changes before connecting: %s', async (target) => {
    await expect(
      followNativeSubagents(
        target,
        headers,
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow('scope changed');
    expect(Socket.instances).toHaveLength(0);
  });
});
