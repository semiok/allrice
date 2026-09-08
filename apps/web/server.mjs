import console from 'node:console';
import { Server } from 'node:http';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

import { bridgeSocketPath } from '@allrice/contracts';
import {
  closeDatabase,
  createBridgeConnectionAuthority,
} from '@allrice/database';
import next from 'next';

import {
  createBridgeLoopbackDispatch,
  createBridgeSocketGateway,
} from './server/bridge-socket.mjs';

/** Next registers its own upgrade listener after the first HTTP request. Route
 * only the dedicated Bridge path before normal EventEmitter dispatch; every
 * other upgrade (including development HMR) remains Next's responsibility. */
export class AllRiceHttpServer extends Server {
  bridgeGateway = null;
  emit(event, ...args) {
    if (
      event === 'upgrade' &&
      args[0]?.url?.split('?')[0] === bridgeSocketPath
    ) {
      if (this.bridgeGateway) void this.bridgeGateway.upgrade(...args);
      else
        args[1].end(
          'HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        );
      return true;
    }
    return super.emit(event, ...args);
  }
}

export async function startAllRiceWeb({
  port = 3000,
  hostname = '0.0.0.0',
  dev = false,
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('INVALID_WEB_PORT');
  const server = new AllRiceHttpServer();
  const app = next({
    dev,
    dir: fileURLToPath(new URL('.', import.meta.url)),
    hostname,
    port,
    httpServer: server,
  });
  await app.prepare();
  const handle = app.getRequestHandler();
  server.on('request', (req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end('Internal Server Error');
    });
  });
  if (process.env.ALLRICE_BRIDGE_WSS_ENABLED === '1') {
    server.bridgeGateway = await createBridgeSocketGateway({
      authority: createBridgeConnectionAuthority(),
      enabled: () =>
        process.env.ALLRICE_BRIDGE_WSS_ENABLED === '1' &&
        process.env.ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED === '1',
      dispatch: createBridgeLoopbackDispatch(port),
    });
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, resolve);
  });
  return {
    server,
    async close() {
      await server.bridgeGateway?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await app.close();
      await closeDatabase();
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const i = args.indexOf(name);
    return i < 0 ? fallback : args[i + 1];
  };
  const runtime = await startAllRiceWeb({
    port: Number(option('--port', process.env.ALLRICE_WEB_PORT ?? 3000)),
    hostname: option('--hostname', '0.0.0.0'),
    dev: args.includes('--dev'),
  });
  console.info('[AllRice Web] HTTP ready; Bridge WSS is explicitly opt-in');
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      void runtime.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
}
