import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { sandboxPublicAddress } from '@allrice/project-runtime';
import { EgressError, type EgressTransport } from './contract.js';

/** Validate all DNS answers and pin the socket. No proxy, second lookup or redirect. */
export function createPublicHttpsTransport(): EgressTransport {
  return {
    async read(url, { maxBytes, signal }) {
      signal.throwIfAborted();
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.hash ||
        (url.port && url.port !== '443') ||
        isIP(url.hostname.replace(/^\[|\]$/g, ''))
      )
        throw new EgressError('DENIED');
      const answers = await lookup(url.hostname, { all: true, verbatim: true });
      signal.throwIfAborted();
      const own = new Set(
        Object.values(networkInterfaces()).flatMap(
          (items) => items?.map((item) => item.address) ?? [],
        ),
      );
      if (
        !answers.length ||
        answers.some(
          (answer) =>
            !sandboxPublicAddress(answer.address) || own.has(answer.address),
        )
      )
        throw new EgressError('DENIED');
      const address = answers[0]!;
      return new Promise((resolve, reject) => {
        let failure: unknown;
        let result: Awaited<ReturnType<EgressTransport['read']>> | undefined;
        let requestClosed = false,
          responseClosed = true;
        const settle = () => {
          if (!requestClosed || !responseClosed) return;
          if (failure) reject(failure);
          else if (result) resolve(result);
          else reject(new EgressError('UNAVAILABLE'));
        };
        const failed = (error: unknown) => {
          failure ??= error;
        };

        const req = request(
          {
            hostname: url.hostname,
            servername: url.hostname,
            port: 443,
            path: url.pathname + url.search,
            method: 'GET',
            signal,
            agent: false,
            family: address.family,
            headers: {
              accept: 'application/json, application/octet-stream',
              'accept-encoding': 'identity',
            },
            lookup: (_hostname, _options, callback) =>
              callback(null, address.address, address.family),
          },
          (response) => {
            responseClosed = false;
            response.once('close', () => {
              responseClosed = true;
              settle();
            });
            response.once('error', failed);
            response.once('aborted', () =>
              failed(new EgressError('UNAVAILABLE')),
            );
            const status = response.statusCode ?? 0;
            if (
              status < 200 ||
              status >= 300 ||
              (response.headers['content-encoding'] &&
                response.headers['content-encoding'] !== 'identity')
            ) {
              failed(new EgressError('INVALID_RESPONSE'));
              response.destroy();
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > maxBytes) {
                response.destroy(new EgressError('LIMIT_EXCEEDED'));
                return;
              }
              chunks.push(chunk);
            });
            response.once('end', () => {
              result = {
                status,
                contentType:
                  response.headers['content-type'] ??
                  'application/octet-stream',
                body: Buffer.concat(chunks),
              };
            });
          },
        );
        req.once('error', failed);
        req.once('close', () => {
          requestClosed = true;
          settle();
        });
        req.end();
      });
    },
  };
}
