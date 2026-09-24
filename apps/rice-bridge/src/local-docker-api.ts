import { request } from 'node:http';
import { lstat, realpath } from 'node:fs/promises';

import { LocalCommandError } from './local-command-inputs.js';
import { localCommandToolchainImageV1 } from '@allrice/contracts';

/** Fixed local Unix socket only. No remote daemon, shell, CLI config or credential helpers. */
export class LocalDockerApi {
  constructor(readonly socketPath: string) {
    if (!socketPath.startsWith('/') || !socketPath.endsWith('.sock'))
      throw new LocalCommandError('LOCAL_DAEMON_REQUIRED');
  }

  async verifySocket() {
    const path = await realpath(this.socketPath);
    const stat = await lstat(path);
    if (!stat.isSocket() || stat.uid !== process.getuid?.())
      throw new LocalCommandError('UNSAFE_DAEMON_SOCKET');
  }

  /** Prepare only the release-pinned public image through the existing daemon.
   * Docker returns NDJSON progress, not the JSON used by its other endpoints. */
  async prepareToolchain(signal: AbortSignal) {
    await this.verifySocket();
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          method: 'POST',
          signal,
          path: `/v1.45/images/create?fromImage=${encodeURIComponent(`node@${localCommandToolchainImageV1}`)}`,
        },
        (res) => {
          let pending = '',
            bytes = 0;
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            bytes += Buffer.byteLength(chunk);
            pending += chunk;
            if (bytes > 8_000_000 || pending.length > 100_000) {
              req.destroy(new LocalCommandError('DAEMON_RESPONSE_LIMIT'));
              return;
            }
            while (pending.includes('\n')) {
              const end = pending.indexOf('\n'),
                line = pending.slice(0, end);
              pending = pending.slice(end + 1);
              if (!line.trim()) continue;
              try {
                if (JSON.parse(line).error) throw Error();
              } catch {
                req.destroy(
                  new LocalCommandError('TOOLCHAIN_PREPARATION_FAILED'),
                );
                return;
              }
            }
          });
          res.once('error', reject);
          res.once('end', () =>
            res.statusCode === 200 && !pending.trim()
              ? resolve()
              : reject(new LocalCommandError('TOOLCHAIN_PREPARATION_FAILED')),
          );
        },
      );
      const timer = setTimeout(
        () => req.destroy(new LocalCommandError('DAEMON_TIMEOUT')),
        120_000,
      );
      req.once('close', () => clearTimeout(timer));
      req.once('error', reject);
      req.end();
    });
  }

  async json<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    timeoutMs = 15_000,
  ): Promise<T> {
    const bytes =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    if (bytes && bytes.length > 1_000_000)
      throw new LocalCommandError('RUNNER_INPUT_LIMIT');
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path: `/v1.45${path}`,
          method,
          headers: bytes
            ? {
                'Content-Type': 'application/json',
                'Content-Length': bytes.length,
              }
            : {},
        },
        (res) => {
          const output: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 2_000_000)
              req.destroy(new LocalCommandError('DAEMON_RESPONSE_LIMIT'));
            else output.push(chunk);
          });
          res.once('error', reject);
          res.once('end', () => {
            if (
              !res.statusCode ||
              res.statusCode < 200 ||
              res.statusCode > 299
            ) {
              reject(
                new LocalCommandError(`DAEMON_HTTP_${res.statusCode ?? 0}`),
              );
              return;
            }
            try {
              resolve(
                (size
                  ? JSON.parse(Buffer.concat(output).toString('utf8'))
                  : null) as T,
              );
            } catch {
              reject(new LocalCommandError('INVALID_DAEMON_RESPONSE'));
            }
          });
        },
      );
      req.once('error', reject);
      // Dribbling bytes must not keep an authorization or stop request alive.
      const timer = setTimeout(
        () => req.destroy(new LocalCommandError('DAEMON_TIMEOUT')),
        timeoutMs,
      );
      req.once('close', () => clearTimeout(timer));
      req.end(bytes);
    });
  }

  /** Docker's non-TTY multiplexed frames, bounded before decoding any JSON lines. */
  async logs(id: string, receive: (bytes: Buffer) => void, timeoutMs: number) {
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new LocalCommandError('INVALID_CONTAINER_ID');
    return new Promise<void>((resolve, reject) => {
      let buffered = Buffer.alloc(0),
        total = 0;
      const req = request(
        {
          socketPath: this.socketPath,
          path: `/v1.45/containers/${id}/logs?stdout=1&stderr=1&follow=1`,
          method: 'GET',
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            reject(new LocalCommandError('DAEMON_LOGS_UNAVAILABLE'));
            return;
          }
          res.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > 500_000) {
              req.destroy(new LocalCommandError('DAEMON_OUTPUT_LIMIT'));
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
                req.destroy(new LocalCommandError('DAEMON_INVALID_FRAME'));
                return;
              }
              if (buffered.length < length + 8) break;
              try {
                receive(buffered.subarray(8, 8 + length));
              } catch {
                req.destroy(new LocalCommandError('DAEMON_INVALID_OUTPUT'));
                return;
              }
              buffered = buffered.subarray(8 + length);
            }
          });
          res.once('error', reject);
          res.once('end', () =>
            buffered.length
              ? reject(new LocalCommandError('DAEMON_OUTPUT_INCOMPLETE'))
              : resolve(),
          );
        },
      );
      req.once('error', reject);
      // An absolute deadline, not an inactivity timer that infinite output can extend.
      const timer = setTimeout(
        () => req.destroy(new LocalCommandError('DAEMON_TIMEOUT')),
        timeoutMs,
      );
      req.once('close', () => clearTimeout(timer));
      req.end();
    });
  }
}
