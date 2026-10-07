import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { ContainerLoopback } from './project-preview-relay.js';
const frame = (bytes: Buffer) => {
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
};
const fixture = () => {
  const socket = new PassThrough();
  const stream = Reflect.construct(ContainerLoopback, [
    socket,
    () => true,
  ]) as ContainerLoopback;
  return { socket, stream };
};
afterEach(() => vi.useRealTimers());
it.each([false, true])(
  'drains all stdout frames after raw EOF, including a slow consumer (%s)',
  async (slow) => {
    const { socket, stream } = fixture(),
      expected = Buffer.alloc(100 * 2048, 97),
      frames = Array.from({ length: 100 }, () => frame(Buffer.alloc(2048, 97)));
    socket.end(Buffer.concat(frames));
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
        if (slow) await delay(1);
      }
      expect(Buffer.concat(chunks)).toEqual(expected);
    } finally {
      stream.destroy();
      socket.destroy();
    }
  },
);
it('rejects an incomplete Docker frame at EOF', async () => {
  const { socket, stream } = fixture();
  socket.end(frame(Buffer.from('abc')).subarray(0, 10));
  await expect(
    (async () => {
      for await (const _chunk of stream) {
        void _chunk;
      }
    })(),
  ).rejects.toThrow('PROJECT_PREVIEW_INCOMPLETE_STREAM');
  stream.destroy();
});
it('clears a cancelled HTTP socket timeout and refreshes it on activity', async () => {
  vi.useFakeTimers();
  const { socket, stream } = fixture(),
    callback = vi.fn();
  stream.setTimeout(1000, callback);
  stream.setTimeout(0);
  await vi.advanceTimersByTimeAsync(2000);
  expect(callback).not.toHaveBeenCalled();
  stream.setTimeout(1000);
  await vi.advanceTimersByTimeAsync(800);
  socket.write(frame(Buffer.from('data')));
  await vi.advanceTimersByTimeAsync(800);
  expect(callback).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(201);
  expect(callback).toHaveBeenCalledTimes(1);
  stream.destroy();
  socket.destroy();
});
