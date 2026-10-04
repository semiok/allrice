import { createServer } from 'node:http';
import { connect } from 'node:net';
import { mkdir, lstat, chmod, unlink } from 'node:fs/promises';
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
    const active = await new Promise<boolean>((resolve, reject) => {
      const socket = connect(socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(Error('CLOUD_PREVIEW_OWNER_UNKNOWN'));
      }, 1000);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED')
          resolve(false);
        else reject(error);
      });
    });
    if (active) throw Error('CLOUD_PREVIEW_ALREADY_OWNED');
    if ((await lstat(socketPath)).ino !== prior.ino)
      throw Error('CLOUD_PREVIEW_OWNER_CHANGED');
    await unlink(socketPath);
  }
  const db = options.database ?? getDatabase(),
    backend = options.backend ?? new CloudRunnerBackend();
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 700_000,
    perMessageDeflate: false,
  });
  server.on('upgrade', (req, socket, head) => {
    if (
      req.url !== '/internal/project-preview' ||
      req.headers.origin ||
      wss.clients.size >= 64
    ) {
      socket.end(
        'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (ws) => {
    let target: ProjectServiceTarget | undefined,
      id: string | undefined,
      lastVerified = 0,
      checking = false,
      closed = false;
    const authorize = async (value: ProjectServiceTarget) => {
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
      const command = CloudProjectCommandSchema.parse(stored?.payload),
        physical = await backend.inspect(value.attemptId);
      if (
        !physical ||
        !physical.State.Running ||
        physical.Id !== value.containerId ||
        physical.Config.Labels['xyz.bplabs.allrice.cloud.service-id'] !==
          value.serviceId
      )
        throw Error('CLOUD_PREVIEW_STOPPED');
      await assertCloudProjectContainer(backend, physical, command);
      lastVerified = Date.now();
    };
    const relay = new ContainerProjectPreviewRelay({
      api: backend,
      alive: (value) =>
        !closed &&
        target?.serviceId === value.serviceId &&
        Date.now() - lastVerified < 2500,
      assertTarget: authorize,
      onError: options.onError,
    });
    const stop = () => {
      closed = true;
      clearInterval(timer);
      relay.close();
      ws.terminate();
    };
    const timer = setInterval(() => {
      if (!target || checking || closed) return;
      checking = true;
      void authorize(target)
        .catch((error) => {
          options.onError?.(error);
          stop();
        })
        .finally(() => {
          checking = false;
        });
    }, 1000);
    timer.unref();
    let queue = Promise.resolve();
    ws.on('message', (raw) => {
      queue = queue
        .then(async () => {
          if (closed) return;
          const frame = ProjectPreviewServerFrameSchema.parse(
            JSON.parse(raw.toString()),
          );
          if (!target) {
            if (frame.type !== 'preview.open')
              throw Error('CLOUD_PREVIEW_OPEN');
            target = frame.target;
            id = frame.id;
            await authorize(target);
          } else if (frame.type === 'preview.open' || frame.id !== id)
            throw Error('CLOUD_PREVIEW_IDENTITY');
          relay.receive(frame, async (response) => {
            if (
              closed ||
              ws.readyState !== WebSocket.OPEN ||
              ws.bufferedAmount > 1_000_000
            )
              return false;
            await new Promise<void>((resolve, reject) =>
              ws.send(JSON.stringify(response), (error) =>
                error ? reject(error) : resolve(),
              ),
            );
            return true;
          });
        })
        .catch((error) => {
          options.onError?.(error);
          stop();
        });
    });
    ws.once('close', stop);
    ws.once('error', stop);
    setTimeout(() => {
      if (!target) stop();
    }, 3000).unref();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  const own = await lstat(socketPath);
  return {
    async close() {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const current = await lstat(socketPath).catch(() => null);
      if (current?.ino === own.ino) await unlink(socketPath);
    },
  };
}
