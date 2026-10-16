import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { bridgeRequest, isBridgePairingRejected } from './client.js';

it.each([
  [
    401,
    'AUTHENTICATION_REQUIRED',
    'Bridge device credential is invalid or revoked',
    true,
  ],
  [401, 'AUTHENTICATION_REQUIRED', 'Authentication required', false],
  [401, undefined, 'Bridge device credential is invalid or revoked', false],
  [
    403,
    'AUTHENTICATION_REQUIRED',
    'Bridge device credential is invalid or revoked',
    false,
  ],
  [503, 'DEPENDENCY_UNAVAILABLE', 'offline', false],
])(
  'recognizes explicit device rejection over HTTP %s without treating other failures as permission to re-pair',
  async (status, code, message, rejected) => {
    const server = createServer((_, response) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code, message } }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw Error('fixture_address');
      let failure: unknown;
      try {
        await bridgeRequest({
          server: `http://127.0.0.1:${address.port}`,
          path: '/api/v1/bridge/device/status',
        });
      } catch (error) {
        failure = error;
      }
      expect(isBridgePairingRejected(failure)).toBe(rejected);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
