import { constants as fsConstants } from 'node:fs';
import { get as httpGet, createServer } from 'node:http';
import { createServer as createTcpServer, type Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { createContext, runInContext } from 'node:vm';
import { expect, it } from 'vitest';
import { projectServiceSupervisor } from './project-service-supervisor.ts';

function supervisor(port: number, readinessMs = 1500, deadlineMs = 3000) {
  const events: { event: { type: string } }[] = [];
  const endings: string[] = [];
  const stdin = new PassThrough();
  const context = createContext({
    a: {
      deadlineUnixMs: Date.now() + deadlineMs,
      command: {
        background: {
          projectService: { port, path: '/', readinessTimeoutMs: readinessMs },
        },
        files: [],
        projectPreparation: { sourceDigest: 'synthetic-owned-source' },
      },
    },
    finished: false,
    fsConstants,
    httpGet,
    Buffer,
    process: {
      env: {
        ALLRICE_SERVICE_ID: 'synthetic-owned-service',
        ALLRICE_SERVICE_ATTEMPT: 'synthetic-owned-attempt',
      },
      stdin,
    },
    emit: (event: (typeof events)[number]) => events.push(event),
    end: (reason: string) => {
      context.finished = true;
      endings.push(reason);
    },
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
  });
  const api = runInContext(
    `${projectServiceSupervisor};({start:projectServiceStarted,close:()=>clearInterval(serviceTimer)})`,
    context,
  ) as { start: (child: null) => Promise<void>; close: () => void };
  return {
    ...api,
    events,
    endings,
    cancel: () =>
      stdin.write(
        JSON.stringify({
          type: 'stop',
          attemptId: 'synthetic-owned-attempt',
          sequence: 0,
        }) + '\n',
      ),
    dispose: () => {
      api.close();
      stdin.removeAllListeners();
      stdin.destroy();
    },
  };
}

it('waits for slow first-request compilation without restarting the HTTP request', async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    setTimeout(() => response.end('compiled'), 600);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('test port');
  const service = supervisor(address.port);
  try {
    await service.start(null);
    expect(requests).toBe(1);
    expect(service.events.map((event) => event.event.type)).toEqual(['ready']);
    expect(service.endings).toEqual([]);
  } finally {
    service.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each([
  { readinessMs: 500, deadlineMs: 3000 },
  { readinessMs: 3000, deadlineMs: 500 },
])(
  'enforces the earlier absolute budget despite continuous partial headers: %j',
  async ({ readinessMs, deadlineMs }) => {
    const sockets = new Set<Socket>();
    const timers = new Set<ReturnType<typeof setInterval>>();
    const server = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('data', () => {
        socket.write('HTTP/1.1 200 OK\r\nX-Still-Compiling: ');
        const timer = setInterval(() => socket.write('x'), 30);
        timers.add(timer);
        socket.once('close', () => {
          clearInterval(timer);
          timers.delete(timer);
        });
      });
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('test port');
    const service = supervisor(address.port, readinessMs, deadlineMs);
    const started = Date.now();
    try {
      await service.start(null);
      expect(Date.now() - started).toBeGreaterThanOrEqual(450);
      expect(Date.now() - started).toBeLessThan(1500);
      expect(service.events).toEqual([]);
      expect(service.endings).toEqual(['readiness_timeout']);
    } finally {
      service.dispose();
      for (const timer of timers) clearInterval(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it('does not announce ready after a stop frame arrives during a slow probe', async () => {
  const server = createServer((_request, response) => {
    setTimeout(() => response.end('compiled'), 600);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('test port');
  const service = supervisor(address.port);
  const cancel = setTimeout(() => service.cancel(), 100);
  try {
    await service.start(null);
    expect(service.events).toEqual([]);
    expect(service.endings).toEqual(['canceled']);
  } finally {
    clearTimeout(cancel);
    service.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
