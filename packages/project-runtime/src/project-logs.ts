import { request } from 'node:http';
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
  return new Promise<void>((resolve, reject) => {
    let buffered = Buffer.alloc(0),
      total = 0;
    const req = request(
      {
        socketPath: socketPath,
        path: `/v1.45/containers/${id}/logs?stdout=1&stderr=1&follow=1`,
        method: 'GET',
        ...(signal ? { signal } : {}),
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new RuntimeCommandError('DAEMON_LOGS_UNAVAILABLE'));
          return;
        }
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > 500_000) {
            req.destroy(new RuntimeCommandError('DAEMON_OUTPUT_LIMIT'));
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
              reject(new RuntimeCommandError('DAEMON_INVALID_FRAME'));
              req.destroy();
              return;
            }
            if (buffered.length < length + 8) break;
            try {
              receive(buffered.subarray(8, 8 + length));
            } catch {
              reject(new RuntimeCommandError('DAEMON_INVALID_OUTPUT'));
              req.destroy();
              return;
            }
            buffered = buffered.subarray(8 + length);
          }
        });
        res.once('error', reject);
        res.once('end', () =>
          buffered.length
            ? reject(new RuntimeCommandError('DAEMON_OUTPUT_INCOMPLETE'))
            : resolve(),
        );
      },
    );
    req.once('error', reject);
    // An absolute deadline, not an inactivity timer that infinite output can extend.
    const timer = setTimeout(
      () => req.destroy(new RuntimeCommandError('DAEMON_TIMEOUT')),
      timeoutMs,
    );
    req.once('close', () => clearTimeout(timer));
    req.end();
  });
}
