import { createServer } from 'node:http';

import { makeHealthResponse } from '@allrice/contracts';
import { closeDatabase, pingDatabase } from '@allrice/database';

const port = Number(process.env.ALLRICE_WORKER_PORT ?? 3101);
const intervalMs = Number(process.env.ALLRICE_WORKER_POLL_INTERVAL_MS ?? 5000);

let databaseReady = false;
let lastDatabaseError: string | undefined;

async function refreshReadiness() {
  try {
    await pingDatabase();
    databaseReady = true;
    lastDatabaseError = undefined;
  } catch (error) {
    databaseReady = false;
    lastDatabaseError =
      error instanceof Error ? error.message : 'Unknown database error';
  }
}

const server = createServer((request, response) => {
  response.setHeader('content-type', 'application/json; charset=utf-8');

  if (request.url === '/health/live') {
    response.statusCode = 200;
    response.end(JSON.stringify(makeHealthResponse('worker', 'live')));
    return;
  }

  if (request.url === '/health/ready') {
    response.statusCode = databaseReady ? 200 : 503;
    response.end(
      JSON.stringify(
        makeHealthResponse(
          'worker',
          databaseReady ? 'ready' : 'not_ready',
          lastDatabaseError,
        ),
      ),
    );
    return;
  }

  response.statusCode = 404;
  response.end(JSON.stringify({ error: 'not_found' }));
});

await refreshReadiness();
const readinessTimer = setInterval(() => void refreshReadiness(), intervalMs);

server.listen(port, '0.0.0.0', () => {
  console.info(`[M5] AllRice worker 0.1.0 listening on ${port}`);
});

async function shutdown(signal: string) {
  console.info(`[M5] received ${signal}; stopping worker`);
  clearInterval(readinessTimer);
  server.close();
  await closeDatabase();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
