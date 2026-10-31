import {
  NativeSubagentFollowEventSchema,
  type NativeSubagentFollowEvent,
} from '@allrice/contracts';
import { createSseDataConsumer } from './sse-data-consumer';

export type NativeSubagentSnapshot = Extract<
  NativeSubagentFollowEvent,
  { type: 'snapshot' }
>['snapshot'];

/** One authorized read-only socket; no replay, retries, or native assembly. */
export async function followNativeSubagents(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  consume: (event: NativeSubagentFollowEvent) => void,
) {
  if (signal.aborted) return;
  const target = new URL(url, location.href);
  if (
    target.origin !== location.origin ||
    target.searchParams.get('workspaceId') !== headers['x-allrice-workspace-id']
  )
    throw Error('native follow scope changed');
  target.searchParams.set(
    'organizationId',
    headers['x-allrice-organization-id'] ?? '',
  );
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(target),
      data = createSseDataConsumer();
    socket.binaryType = 'arraybuffer';
    const finish = (error?: unknown) => {
      signal.removeEventListener('abort', cancel);
      socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
      if (error) reject(error);
      else resolve();
    };
    const cancel = () => finish();
    signal.addEventListener('abort', cancel, { once: true });
    socket.onmessage = (event) => {
      if (signal.aborted) return;
      try {
        if (!(event.data instanceof ArrayBuffer))
          throw Error('invalid native follow frame');
        for (const value of data(new Uint8Array(event.data))) {
          if (signal.aborted) return;
          consume(NativeSubagentFollowEventSchema.parse(JSON.parse(value)));
        }
      } catch (error) {
        finish(error);
      }
    };
    socket.onerror = () => finish(Error('native follow unavailable'));
    socket.onclose = (event) =>
      finish(
        event.code === 1000 ? undefined : Error('native follow unavailable'),
      );
  });
}
