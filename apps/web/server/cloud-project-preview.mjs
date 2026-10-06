import { WebSocket } from 'ws';
import {
  ProjectPreviewClientFrameSchema,
  ProjectPreviewServerFrameSchema,
} from '@allrice/contracts';
import { isAbsolute } from 'node:path';
import { createPendingWork } from './pending-work.mjs';

/** close() joins local sockets and accepted callbacks, not Worker/container
 * shutdown. Internal callbacks signal stop without awaiting their own drain. */
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
  let stopping = false,
    closing,
    cleanupFailed = false;
  return {
    async openPreview({ id, target, request, onFrame, onClose }) {
      if (stopping || target.backend !== 'cloud' || active.size >= 64)
        throw Error('CLOUD_PREVIEW_UNAVAILABLE');
      const work = createPendingWork();
      const ws = new WebSocket(
        'ws+unix://' + socketPath + ':/internal/project-preview',
        {
          perMessageDeflate: false,
          maxPayload: 700_000,
          handshakeTimeout: 3000,
        },
      );
      const socketClosed = new Promise((resolve) => ws.once('close', resolve));
      let closed = false,
        queue = Promise.resolve(),
        done;
      const record = {
        close: () => {
          requestClose();
          return done;
        },
      };
      active.add(record);
      function requestClose() {
        if (closed) return;
        closed = true;
        ws.terminate();
        done = (async () => {
          await socketClosed;
          await work.drain();
          // Notifications signal their owner's close; they must not join this
          // channel's completion from inside this notification.
          await onClose?.();
        })();
        void done.then(
          () => active.delete(record),
          () => {
            cleanupFailed = true;
            active.delete(record);
          },
        );
      }
      ws.on('message', (raw) => {
        if (closed) return;
        // Accepted frames drain in order even when the peer closes immediately
        // after sending its terminal frame.
        queue = work.track(
          queue
            .then(async () => {
              const frame = ProjectPreviewClientFrameSchema.parse(
                JSON.parse(raw.toString()),
              );
              if (frame.id !== id) throw Error('CLOUD_PREVIEW_IDENTITY');
              await onFrame(frame);
            })
            .catch((error) => {
              try {
                onError(error);
              } finally {
                requestClose();
              }
            }),
        );
      });
      ws.once('close', requestClose);
      ws.on('error', requestClose);
      const send = (frame) => {
        const parsed = ProjectPreviewServerFrameSchema.parse({
          ...frame,
          version: 1,
          id,
        });
        if (
          closed ||
          stopping ||
          parsed.id !== id ||
          ws.readyState !== WebSocket.OPEN ||
          ws.bufferedAmount > 1_000_000
        )
          return Promise.reject(Error('CLOUD_PREVIEW_LOST'));
        return work.run(async () => {
          if (closed || stopping || ws.readyState !== WebSocket.OPEN)
            throw Error('CLOUD_PREVIEW_LOST');
          await new Promise((resolve, reject) =>
            ws.send(JSON.stringify(parsed), (error) =>
              error ? reject(error) : resolve(),
            ),
          );
          return true;
        });
      };
      try {
        await work.track(
          new Promise((resolve, reject) => {
            ws.once('open', resolve);
            ws.once('error', reject);
            ws.once('close', () => reject(Error('CLOUD_PREVIEW_LOST')));
          }),
        );
        if (closed || stopping) throw Error('CLOUD_PREVIEW_LOST');
        await send({ version: 1, type: 'preview.open', id, target, request });
        if (closed || stopping) throw Error('CLOUD_PREVIEW_LOST');
      } catch (error) {
        requestClose();
        await done;
        throw error;
      }
      return { send, close: record.close };
    },
    close() {
      if (closing) return closing;
      stopping = true;
      const completions = [...active].map((record) => record.close());
      closing = (async () => {
        const results = await Promise.allSettled(completions);
        if (
          cleanupFailed ||
          results.some((result) => result.status === 'rejected')
        )
          throw Error('CLOUD_PREVIEW_CLEANUP_UNCONFIRMED');
      })();
      return closing;
    },
  };
}
