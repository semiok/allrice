import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

import { McpEndpointSchema, McpError } from '@allrice/contracts';
import { createPinnedLookup } from '../pinned-lookup.js';
import { isPublicWebAddress } from '../web-fetch.js';

export function validateMcpEndpoint(input: string) {
  const url = new URL(McpEndpointSchema.parse(input));
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    /\.(localhost|local|internal)$/.test(host) ||
    (isIP(host) && !isPublicWebAddress(host))
  )
    throw new McpError('MCP_SOURCE_DENIED');
  return url;
}

/** SDK networking is confined to one administrator-authorized endpoint.
 * DNS is checked for every request and pinned into the actual TLS connection.
 * There is deliberately no production localhost, proxy or redirect exception. */
export function createPinnedMcpFetch(input: {
  endpoint: string;
  bearerToken: string;
  signal: AbortSignal;
  assertAuthorized: () => Promise<void>;
}): typeof fetch {
  const endpoint = validateMcpEndpoint(input.endpoint);
  return async (requestInput, init) => {
    const url = new URL(
      typeof requestInput === 'string'
        ? requestInput
        : requestInput instanceof URL
          ? requestInput.href
          : requestInput.url,
    );
    if (
      url.href !== endpoint.href ||
      !['GET', 'POST', 'DELETE'].includes(init?.method ?? 'GET')
    )
      throw new McpError('MCP_SOURCE_DENIED');
    await input.assertAuthorized();
    input.signal.throwIfAborted();
    init?.signal?.throwIfAborted();
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (
      !addresses.length ||
      addresses.some((entry) => !isPublicWebAddress(entry.address))
    )
      throw new McpError('MCP_SOURCE_DENIED');
    const address = addresses[0]!;
    const body = init?.body;
    if (
      body !== undefined &&
      body !== null &&
      (typeof body !== 'string' || Buffer.byteLength(body) > 262_144)
    )
      throw new McpError('MCP_LIMIT');
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${input.bearerToken}`);
    headers.set('accept-encoding', 'identity');
    headers.delete('host');
    headers.delete('cookie');
    headers.delete('proxy-authorization');
    const signal = AbortSignal.any([
      input.signal,
      ...(init?.signal ? [init.signal] : []),
    ]);
    return new Promise<Response>((resolve, reject) => {
      const request = httpsRequest(
        url,
        {
          method: init?.method ?? 'GET',
          headers: Object.fromEntries(headers),
          signal,
          family: address.family,
          lookup: createPinnedLookup(address),
        },
        (response) => {
          const status = response.statusCode ?? 500;
          if (status >= 300 && status < 400) {
            response.destroy();
            reject(new McpError('MCP_SOURCE_DENIED'));
            return;
          }
          if (
            response.headers['content-encoding'] &&
            response.headers['content-encoding'] !== 'identity'
          ) {
            response.destroy();
            reject(new McpError('MCP_LIMIT'));
            return;
          }
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers))
            if (value !== undefined)
              responseHeaders.set(
                name,
                Array.isArray(value) ? value.join(', ') : value,
              );
          if ([204, 205, 304].includes(status)) {
            response.resume();
            resolve(new Response(null, { status, headers: responseHeaders }));
            return;
          }
          let bytes = 0;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              response.on('data', (chunk: Buffer) => {
                bytes += chunk.byteLength;
                if (bytes > 1_048_576) {
                  response.destroy(new McpError('MCP_LIMIT'));
                  return;
                }
                controller.enqueue(new Uint8Array(chunk));
              });
              response.on('end', () => controller.close());
              response.on('error', () =>
                controller.error(new McpError('MCP_UNAVAILABLE')),
              );
            },
            cancel() {
              response.destroy();
              request.destroy();
            },
          });
          resolve(new Response(stream, { status, headers: responseHeaders }));
        },
      );
      request.setTimeout(30_000, () =>
        request.destroy(new McpError('MCP_UNAVAILABLE')),
      );
      request.on('error', () => reject(new McpError('MCP_UNAVAILABLE')));
      request.end(body ?? undefined);
    });
  };
}
