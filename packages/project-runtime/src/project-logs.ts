import { request, type IncomingMessage } from 'node:http';
import { RuntimeCommandError } from './errors.js';
export async function streamProjectLogs(
  socketPath: string,
  id: string,
  receive: (bytes: Buffer) => void,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  if (!/^[a-f0-9]{64}$/.test(id))
    throw new RuntimeCommandError('INVALID_CONTAINER_ID');
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    let buffered = Buffer.alloc(0),
      total = 0;
    let settled = false;
    let response: IncomingMessage | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
      // The complete response may have detached its socket's error listener.
      // Keep transport error handlers, but close without injecting a new error.
      response?.destroy();
      req.destroy();
    };
    const abort = () => fail(signal?.reason);
    const req = request(
      {
        socketPath: socketPath,
        path: `/v1.45/containers/${id}/logs?stdout=1&stderr=1&follow=1`,
        method: 'GET',
      },
      (res) => {
        response = res;
        res.once('error', fail);
        if (settled) {
          res.destroy();
          return;
        }
        if (res.statusCode !== 200) {
          fail(new RuntimeCommandError('DAEMON_LOGS_UNAVAILABLE'));
          return;
        }
        res.once('aborted', () =>
          fail(new RuntimeCommandError('DAEMON_OUTPUT_INCOMPLETE')),
        );
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          total += chunk.length;
          if (total > 500_000) {
            fail(new RuntimeCommandError('DAEMON_OUTPUT_LIMIT'));
            return;
          }
          buffered = Buffer.concat([buffered, chunk]);
          while (buffered.length >= 8) {
            const length = buffered.readUInt32BE(4);
            if (
              length > 250_000 ||
              ![1, 2].includes(buffered[0] ?? 0) ||
              buffered.readUIntBE(1, 3) !== 0
            ) {
              fail(new RuntimeCommandError('DAEMON_INVALID_FRAME'));
              return;
            }
            if (buffered.length < length + 8) break;
            try {
              receive(buffered.subarray(8, 8 + length));
            } catch {
              fail(new RuntimeCommandError('DAEMON_INVALID_OUTPUT'));
              return;
            }
            if (settled) return;
            buffered = buffered.subarray(8 + length);
          }
        });
        res.once('end', () => {
          if (settled) return;
          if (signal?.aborted) {
            abort();
            return;
          }
          if (buffered.length) {
            fail(new RuntimeCommandError('DAEMON_OUTPUT_INCOMPLETE'));
            return;
          }
          settled = true;
          cleanup();
          resolve();
        });
      },
    );
    req.once('error', fail);
    // An absolute deadline, not an inactivity timer that infinite output can extend.
    const timer = setTimeout(
      () => fail(new RuntimeCommandError('DAEMON_TIMEOUT')),
      timeoutMs,
    );
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (!settled) req.end();
  });
}
