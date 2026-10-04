import { WebSocket } from 'ws';
import {
  ProjectPreviewClientFrameSchema,
  ProjectPreviewServerFrameSchema,
} from '@allrice/contracts';
import { isAbsolute } from 'node:path';

/** Client for the Worker's filesystem-restricted transport. One channel for
 * one immutable target; disconnect/uncertain ACK never falls back or replays. */
export function createCloudProjectPreviewTransport(
  socketPath,
  { onError = () => {} } = {},
) {
  if (
    !isAbsolute(socketPath) ||
    socketPath.length > 100 ||
    /[:?#\0]/.test(socketPath)
  )
    throw Error('CLOUD_PREVIEW_SOCKET');
  const active = new Set();
  return {
    async openPreview({ id, target, request, onFrame, onClose }) {
      if (target.backend !== 'cloud' || active.size >= 64)
        throw Error('CLOUD_PREVIEW_UNAVAILABLE');
      const ws = new WebSocket(
        'ws+unix://' + socketPath + ':/internal/project-preview',
        {
          perMessageDeflate: false,
          maxPayload: 700_000,
          handshakeTimeout: 3000,
        },
      );
      active.add(ws);
      let closed = false,
        queue = Promise.resolve();
      const close = () => {
        if (closed) return;
        closed = true;
        active.delete(ws);
        ws.terminate();
        void queue.finally(() => onClose?.()).catch(() => undefined);
      };
      ws.on('message', (raw) => {
        queue = queue
          .then(async () => {
            const frame = ProjectPreviewClientFrameSchema.parse(
              JSON.parse(raw.toString()),
            );
            if (frame.id !== id) throw Error('CLOUD_PREVIEW_IDENTITY');
            await onFrame(frame);
          })
          .catch((error) => {
            onError(error);
            close();
          });
      });
      ws.once('close', close);
      ws.on('error', close);
      const send = async (frame) => {
        const parsed = ProjectPreviewServerFrameSchema.parse({
          ...frame,
          version: 1,
          id,
        });
        if (
          closed ||
          parsed.id !== id ||
          ws.readyState !== WebSocket.OPEN ||
          ws.bufferedAmount > 1_000_000
        )
          throw Error('CLOUD_PREVIEW_LOST');
        await new Promise((resolve, reject) =>
          ws.send(JSON.stringify(parsed), (error) =>
            error ? reject(error) : resolve(),
          ),
        );
        return true;
      };
      try {
        await new Promise((resolve, reject) => {
          ws.once('open', resolve);
          ws.once('error', reject);
          ws.once('close', () => reject(Error('CLOUD_PREVIEW_LOST')));
        });
        await send({ version: 1, type: 'preview.open', id, target, request });
      } catch (error) {
        close();
        throw error;
      }
      return { send, close };
    },
    close() {
      for (const ws of active) ws.terminate();
      active.clear();
    },
  };
}
