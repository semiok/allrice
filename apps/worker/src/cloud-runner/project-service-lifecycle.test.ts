import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { CloudProjectCommand } from '@allrice/contracts';
import { CloudRunnerBackend, type CloudRunResult } from './backend.js';

describe('cloud service bounded failure ownership', () => {
  for (const failure of ['shutdown', 'authority unavailable'] as const)
    it(
      failure +
        ' closes control and stalled Docker logs without claiming cleanup',
      async () => {
        const directory = await mkdtemp('/tmp/ar-life-'),
          socket = join(directory, 'docker.sock'),
          server = createServer();
        let logClosed = false;
        server.on('request', (_request, response) => {
          response.writeHead(200);
          response.flushHeaders();
          response.once('close', () => {
            logClosed = true;
          });
        });
        server.listen(socket);
        await once(server, 'listening');
        vi.stubEnv('ALLRICE_CLOUD_DOCKER_SOCKET', socket);
        const backend = new CloudRunnerBackend(),
          stdin = new PassThrough(),
          abort = new AbortController();
        const guard = { renew: vi.fn(async () => {}), close: vi.fn() };
        const stopping = vi
          .spyOn(backend, 'stop')
          .mockImplementation(() => new Promise(() => {}));
        const collecting = vi.spyOn(backend, 'collect');
        const cleanup = vi.spyOn(backend, 'cleanup');
        const id = randomUUID(),
          deadline = new Date(Date.now() + 3_600_000).toISOString();
        const options = {
          attemptId: randomUUID(),
          deadlineAt: deadline,
          signal: abort.signal,
          maintainLease: async () => true,
          projectService: {
            id,
            hardDeadlineAt: deadline,
            exchange: () =>
              failure === 'authority unavailable'
                ? new Promise(() => {})
                : Promise.resolve({
                    stopRequested: false,
                    leaseExpiresAt: deadline,
                    projectService: {
                      expiresAt: deadline,
                      previewHost: null,
                      sourceUpdate: null,
                    },
                  }),
            onEvent: async () => {},
            onSourceApplied: async () => {},
          },
        };
        const command = {
          arguments: { limits: { outputBytes: 1024 } },
        } as unknown as CloudProjectCommand;
        const execute = Reflect.get(backend, 'runProjectService').bind(
          backend,
        ) as (...args: unknown[]) => Promise<CloudRunResult>;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const started = Date.now();
        try {
          const task = execute(
            'a'.repeat(64),
            command,
            options,
            stdin,
            started,
            Date.parse(deadline),
            async () => {},
            guard,
          );
          if (failure === 'shutdown')
            timer = setTimeout(() => abort.abort(), 250);
          await expect(task).rejects.toThrow();
          expect(Date.now() - started).toBeLessThan(12_000);
          expect(guard.close).toHaveBeenCalled();
          expect(stdin.destroyed).toBe(true);
          await expect.poll(() => logClosed, { timeout: 1000 }).toBe(true);
          expect(stopping).toHaveBeenCalledWith(options.attemptId);
          expect(collecting).not.toHaveBeenCalled();
          expect(cleanup).not.toHaveBeenCalled();
        } finally {
          if (timer) clearTimeout(timer);
          abort.abort();
          stdin.destroy();
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await rm(directory, { recursive: true, force: true });
          vi.restoreAllMocks();
          vi.unstubAllEnvs();
        }
      },
      16000,
    );
});
