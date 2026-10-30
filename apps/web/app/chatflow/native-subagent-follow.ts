import {
  NativeSubagentFollowEventSchema,
  type NativeSubagentFollowEvent,
} from '@allrice/contracts';
import { createSseDataConsumer } from './sse-data-consumer';

/** One authorized connection; no replay, retries, or native state assembly. */
export async function followNativeSubagents(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  consume: (event: NativeSubagentFollowEvent) => void,
) {
  const response = await fetch(url, { headers, signal, cache: 'no-store' });
  if (
    !response.ok ||
    !response.body ||
    !response.headers.get('content-type')?.startsWith('text/event-stream')
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error('native follow unavailable');
  }
  const reader = response.body.getReader(),
    data = createSseDataConsumer();
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (signal.aborted || chunk.done) return;
      for (const value of data(chunk.value)) {
        if (signal.aborted) return;
        consume(NativeSubagentFollowEventSchema.parse(JSON.parse(value)));
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
