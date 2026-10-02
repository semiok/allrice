import { createHash } from 'node:crypto';
import type { RuntimeLocalPdfSource } from '@allrice/contracts';

export interface LocalPdfTransport {
  download(source: RuntimeLocalPdfSource, signal: AbortSignal): Promise<Buffer>;
}

/** Same authenticated operation byte route as PR3/Python, with read-only
 * source authority on the server. No upload, model URL or host path. */
export function localPdfHttpTransport(input: {
  server: string;
  token: string;
  id: string;
  leaseToken: string;
}): LocalPdfTransport {
  return {
    async download(source, signal) {
      const response = await fetch(
        new URL(
          `/api/v1/bridge/device/file-transfers/operation/${input.id}?action=download&objectId=${source.objectId}`,
          input.server,
        ),
        {
          redirect: 'error',
          headers: {
            authorization: `Bearer ${input.token}`,
            'x-allrice-lease': input.leaseToken,
          },
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        },
      ).catch((error) => {
        if (signal.aborted) throw error;
        throw Error('PDF_SOURCE_UNAVAILABLE');
      });
      if (
        !response.ok ||
        !response.body ||
        response.headers.get('x-allrice-checksum') !== source.checksum ||
        Number(response.headers.get('content-length')) !== source.sizeBytes
      )
        throw Error('PDF_SOURCE_CHANGED');
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > source.sizeBytes) throw Error('PDF_INPUT_LIMIT');
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const bytes = Buffer.concat(chunks);
      if (
        size !== source.sizeBytes ||
        `sha256:${createHash('sha256').update(bytes).digest('hex')}` !==
          source.checksum
      )
        throw Error('PDF_SOURCE_CHANGED');
      return bytes;
    },
  };
}
