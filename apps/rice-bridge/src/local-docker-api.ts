import { request } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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

  /** Fixed Engine endpoints carry actual bytes; JSON and logs remain bounded metadata. */
  async putArchive(
    id: string,
    path: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ) {
    if (!/^[a-f0-9]{64}$/.test(id) || path !== '/tmp/work')
      throw new LocalCommandError('INVALID_ARCHIVE_TARGET');
    if (bytes.byteLength > 24_000_000)
      throw new LocalCommandError('RUNNER_INPUT_LIMIT');
    await this.streamRequest(
      'PUT',
      `/containers/${id}/archive?path=${encodeURIComponent(path)}&noOverwriteDirNonDir=1`,
      Readable.from([bytes]),
      bytes.byteLength,
      signal,
      4096,
    );
  }

  async loadImageArchive(stream: Readable, size: number, signal: AbortSignal) {
    if (!Number.isSafeInteger(size) || size < 1 || size > 2_000_000_000)
      throw new LocalCommandError('RUNNER_INPUT_LIMIT');
    const response = await this.streamRequest(
      'POST',
      '/images/load?quiet=1',
      stream,
      size,
      signal,
      65_536,
    );
    for (const line of response
      .toString('utf8')
      .split('\n')
      .filter((s) => s.trim())) {
      try {
        if (JSON.parse(line).error) throw Error();
      } catch {
        throw new LocalCommandError('PYTHON_IMAGE_IMPORT_FAILED');
      }
    }
  }

  async getArchive(
    id: string,
    path: string,
    maximum: number,
    signal: AbortSignal,
  ) {
    if (
      !/^[a-f0-9]{64}$/.test(id) ||
      !path.startsWith('/tmp/work/') ||
      path.split('/').includes('..') ||
      /[\0\\]/.test(path)
    )
      throw new LocalCommandError('INVALID_ARCHIVE_TARGET');
    return this.streamRequest(
      'GET',
      `/containers/${id}/archive?path=${encodeURIComponent(path)}`,
      undefined,
      0,
      signal,
      maximum,
    );
  }

  private async streamRequest(
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    body: Readable | undefined,
    size: number,
    signal: AbortSignal,
    maximum: number,
  ) {
    await this.verifySocket();
    signal.throwIfAborted();
    const bound = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
    return new Promise<Buffer>((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path: `/v1.45${path}`,
          method,
          signal: bound,
          headers: body
            ? { 'Content-Type': 'application/x-tar', 'Content-Length': size }
            : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > maximum)
              req.destroy(new LocalCommandError('DAEMON_RESPONSE_LIMIT'));
            else chunks.push(chunk);
          });
          res.once('error', reject);
          res.once('end', () => {
            if (!res.statusCode || res.statusCode < 200 || res.statusCode > 299)
              reject(
                new LocalCommandError(`DAEMON_HTTP_${res.statusCode ?? 0}`),
              );
            else resolve(Buffer.concat(chunks));
          });
        },
      );
      req.once('error', reject);
      if (body)
        void pipeline(body, req, { signal: bound }).catch((error) =>
          req.destroy(error),
        );
      else req.end();
    });
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
