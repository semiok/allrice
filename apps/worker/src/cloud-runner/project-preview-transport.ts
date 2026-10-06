import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import {
  mkdir,
  mkdtemp,
  lstat,
  chmod,
  unlink,
  link,
  rmdir,
} from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { ContainerProjectPreviewRelay } from '@allrice/project-runtime';
import {
  ProjectPreviewServerFrameSchema,
  CloudProjectCommandSchema,
  runtimeContractEqual,
  type ProjectServiceTarget,
} from '@allrice/contracts';
import { getDatabase, projectServicePreviewTarget } from '@allrice/database';
import { CloudRunnerBackend } from './backend.js';
import { assertCloudProjectContainer } from './project.js';

/** Private frame transport, with no public routing or Docker API. Web must
 * still authorize the browser; Worker independently authorizes every target. */
export async function startCloudProjectPreviewTransport(
  socketPath: string,
  options: {
    backend?: CloudRunnerBackend;
    database?: ReturnType<typeof getDatabase>;
    onError?: (error: unknown) => void;
  } = {},
) {
  if (!isAbsolute(socketPath) || socketPath.length > 100)
    throw Error('CLOUD_PREVIEW_SOCKET');
  const parent = dirname(socketPath),
    uid = process.getuid?.();
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await lstat(parent);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== uid ||
    directory.mode & 0o077
  )
    throw Error('CLOUD_PREVIEW_DIRECTORY');
  const prior = await lstat(socketPath).catch((e) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (prior) {
    if (!prior.isSocket() || prior.uid !== uid || prior.mode & 0o077)
      throw Error('CLOUD_PREVIEW_SOCKET');
    const probe = connect(socketPath);
    const probeClosed = new Promise<void>((resolve) =>
      probe.once('close', resolve),
    );
    const active = await (async () => {
      try {
        return await new Promise<boolean>((resolve, reject) => {
          const timer = setTimeout(() => {
            probe.destroy();
            reject(Error('CLOUD_PREVIEW_OWNER_UNKNOWN'));
          }, 1000);
          probe.once('connect', () => {
            clearTimeout(timer);
            resolve(true);
          });
          probe.once('error', (error) => {
            clearTimeout(timer);
            if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED')
              resolve(false);
            else reject(error);
          });
        });
      } finally {
        probe.destroy();
        await probeClosed;
      }
    })();
    if (active) throw Error('CLOUD_PREVIEW_ALREADY_OWNED');
    if ((await lstat(socketPath)).ino !== prior.ino)
      throw Error('CLOUD_PREVIEW_OWNER_CHANGED');
    await unlink(socketPath);
  }
  const db = options.database ?? getDatabase(),
    backend = options.backend ?? new CloudRunnerBackend();
  let stopping = false,
    listening = false;
  let bindingDirectory: string | undefined;
  let closing: Promise<void> | undefined, cleanupFailure: unknown;
  const sockets = new Map<Socket, Promise<void>>();
  const owners = new Set<{ stop: () => Promise<void> }>();
  // Reporting cannot interrupt unconditional cleanup or wait on its own drain.
  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      /* error reporter only */
    }
  };
  const server = createServer((_req, res) => {
    res.writeHead(stopping ? 503 : 404);
    res.end();
  });
  server.on('connection', (socket) => {
    const done = new Promise<void>((resolve) => socket.once('close', resolve));
    sockets.set(socket, done);
    void done.then(() => sockets.delete(socket));
    if (stopping || sockets.size > 64) socket.destroy();
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 700_000,
    perMessageDeflate: false,
  });
  server.on('upgrade', (req, socket, head) => {
    if (
      stopping ||
      owners.size >= 64 ||
      req.url !== '/internal/project-preview' ||
      req.headers.origin ||
      sockets.size > 64
    ) {
      socket.end(
        'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (stopping) ws.terminate();
      else wss.emit('connection', ws);
    });
  });
  wss.on('connection', (ws) => {
    const work = pendingWork();
    let target: ProjectServiceTarget | undefined, id: string | undefined;
    let lastVerified = 0,
      checking = false,
      closed = false;
    let done: Promise<void> | undefined, failed: unknown;
    const socketClosed = new Promise<void>((resolve) =>
      ws.once('close', resolve),
    );
    const assertOpen = () => {
      if (closed || stopping) throw Error('CLOUD_PREVIEW_CLOSING');
    };
    const authorize = (value: ProjectServiceTarget) =>
      work.run(async () => {
        assertOpen();
        if (value.backend !== 'cloud' || value.deviceId !== null)
          throw Error('CLOUD_PREVIEW_TARGET');
        const fresh = await projectServicePreviewTarget(
          {
            organizationId: value.organizationId,
            workspaceId: value.workspaceId,
            actor: { type: 'user', id: value.ownerId },
          },
          value.serviceId,
          db,
        );
        assertOpen();
        for (const key of [
          'serviceId',
          'organizationId',
          'workspaceId',
          'ownerId',
          'backend',
          'deviceId',
          'operationId',
          'attemptId',
          'containerId',
          'imageDigest',
          'port',
          'hardDeadlineAt',
        ] as const)
          if (!runtimeContractEqual(fresh[key], value[key]))
            throw Error('CLOUD_PREVIEW_TARGET_CHANGED');
        const [stored] = await db<
          { payload: unknown }[]
        >`select payload from allrice_cloud_execution_inputs where operation_id=${value.operationId}`;
        assertOpen();
        const command = CloudProjectCommandSchema.parse(stored?.payload);
        const physical = await backend.inspect(value.attemptId);
        assertOpen();
        if (
          !physical ||
          !physical.State.Running ||
          physical.Id !== value.containerId ||
          physical.Config.Labels['xyz.bplabs.allrice.cloud.service-id'] !==
            value.serviceId
        )
          throw Error('CLOUD_PREVIEW_STOPPED');
        await assertCloudProjectContainer(backend, physical, command);
        assertOpen();
        lastVerified = Date.now();
      });
    const relay = new ContainerProjectPreviewRelay({
      api: backend,
      alive: (value) =>
        !closed &&
        !stopping &&
        target?.serviceId === value.serviceId &&
        Date.now() - lastVerified < 2500,
      assertTarget: authorize,
      onError: report,
    });
    const stop = () => {
      if (done) return done;
      closed = true;
      clearInterval(timer);
      clearTimeout(firstFrame);
      // Shared relay.close is still void; this joins IPC work, not Docker/helper lifetime.
      try {
        relay.close();
      } catch (error) {
        failed = error;
      }
      ws.terminate();
      done = (async () => {
        await Promise.all([socketClosed, work.drain()]);
        if (failed) throw failed;
      })();
      void done.then(
        () => owners.delete(owner),
        (error) => {
          cleanupFailure ??= error;
          owners.delete(owner);
          report(error);
        },
      );
      return done;
    };
    const owner = { stop };
    owners.add(owner);
    const timer = setInterval(() => {
      if (!target || checking || closed || stopping) return;
      checking = true;
      void authorize(target)
        .catch((error) => {
          stop();
          report(error);
        })
        .finally(() => {
          checking = false;
        });
    }, 1000);
    timer.unref();
    const firstFrame = setTimeout(() => {
      if (!target) stop();
    }, 3000);
    firstFrame.unref();
    let queue = Promise.resolve();
    ws.on('message', (raw) => {
      if (closed || stopping) return;
      // Retain queued work before dispatch; a disconnected owner cannot vanish early.
      queue = work.track(
        queue
          .then(async () => {
            if (closed || stopping) return;
            const frame = ProjectPreviewServerFrameSchema.parse(
              JSON.parse(raw.toString()),
            );
            if (!target) {
              if (frame.type !== 'preview.open')
                throw Error('CLOUD_PREVIEW_OPEN');
              target = frame.target;
              id = frame.id;
              clearTimeout(firstFrame);
              await authorize(target);
              assertOpen();
            } else if (frame.type === 'preview.open' || frame.id !== id)
              throw Error('CLOUD_PREVIEW_IDENTITY');
            relay.receive(frame, (response) => {
              if (
                closed ||
                stopping ||
                ws.readyState !== WebSocket.OPEN ||
                ws.bufferedAmount > 1_000_000
              )
                return Promise.resolve(false);
              return work.run(async () => {
                if (closed || stopping || ws.readyState !== WebSocket.OPEN)
                  return false;
                await new Promise<void>((resolve, reject) =>
                  ws.send(JSON.stringify(response), (error) =>
                    error ? reject(error) : resolve(),
                  ),
                );
                return !closed && !stopping;
              });
            });
          })
          .catch((error) => {
            stop();
            report(error);
          }),
      );
    });
    ws.once('close', () => {
      stop();
    });
    ws.once('error', (error) => {
      stop();
      report(error);
    });
    if (stopping) stop();
  });
  function close() {
    if (closing) return closing;
    stopping = true;
    const completions = [...owners].map((owner) => owner.stop());
    const rawClosed = [...sockets.values()];
    for (const socket of sockets.keys()) socket.destroy();
    const listenerClosed = new Promise<void>((resolve, reject) => {
      server.close((error) => (error && listening ? reject(error) : resolve()));
    });
    const wsClosed = new Promise<void>((resolve, reject) =>
      wss.close((error) => (error ? reject(error) : resolve())),
    );
    closing = (async () => {
      const results = await Promise.allSettled([
        ...completions,
        ...rawClosed,
        listenerClosed,
        wsClosed,
      ]);
      const rejected = results.find((r) => r.status === 'rejected');
      if (rejected?.status === 'rejected') cleanupFailure ??= rejected.reason;
      // Keep the public stale name. Stat followed by unlink is not an atomic
      // inode comparison and can delete a concurrently published replacement.
      // Startup retains the existing stale-name probe/ownership checks; full
      // publication exclusion remains a supervisor/ownership boundary.
      if (bindingDirectory) await rmdir(bindingDirectory);
      if (cleanupFailure) throw cleanupFailure;
    })();
    return closing;
  }
  try {
    // Node automatically unlinks its bound Unix path on close. Bind privately
    // and expose the same socket inode by hard link, so a replaced public path
    // cannot be removed by server.close before our ownership check.
    bindingDirectory = await mkdtemp(parent + '/p-');
    const bindingPath = bindingDirectory + '/s';
    if (bindingPath.length > 100) throw Error('CLOUD_PREVIEW_SOCKET');
    await new Promise<void>((resolve, reject) => {
      const error = (e: Error) => {
        server.off('listening', ready);
        reject(e);
      };
      const ready = () => {
        server.off('error', error);
        listening = true;
        resolve();
      };
      server.once('error', error);
      server.once('listening', ready);
      server.listen(bindingPath);
    });
    await chmod(bindingPath, 0o600);
    await link(bindingPath, socketPath);
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'CLOUD_PREVIEW_STARTUP_CLEANUP',
      );
    }
    throw error;
  }
  return { close };
}

function pendingWork() {
  const pending = new Set<Promise<unknown>>();
  const track = <T>(promise: Promise<T>) => {
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  };
  return {
    track,
    run: <T>(body: () => Promise<T>) => track(Promise.resolve().then(body)),
    async drain() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}
