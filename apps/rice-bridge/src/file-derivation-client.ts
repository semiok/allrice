import { LocalFileObjectSchema } from '@allrice/contracts';
import { localFileHttpTransport } from './local-file-client.js';
import {
  FileDerivationError,
  type FileDerivationContent,
} from './file-derivation.js';

/** Same operation lease and streamed private attachment boundary as original files.
 * The output is a derived object, never a fabricated physical source version. */
export function fileDerivationHttpTransport(input: {
  server: string;
  token: string;
  id: string;
  leaseToken: string;
  signal: AbortSignal;
}) {
  const { authorize } = localFileHttpTransport({ ...input, kind: 'operation' });
  return {
    authorize,
    async upload(
      metadata: FileDerivationContent,
      bytes: Uint8Array,
      signal: AbortSignal,
    ) {
      signal.throwIfAborted();
      if (!(await authorize(true)))
        throw new FileDerivationError('FILE_CANCELED');
      try {
        const response = await fetch(
          new URL(
            `/api/v1/bridge/device/file-transfers/operation/${input.id}`,
            input.server,
          ),
          {
            method: 'POST',
            redirect: 'error',
            headers: {
              authorization: `Bearer ${input.token}`,
              'x-allrice-lease': input.leaseToken,
              'content-type': 'application/octet-stream',
              'x-allrice-file': encodeURIComponent(JSON.stringify(metadata)),
            },
            body: Buffer.from(bytes),
            signal,
          },
        );
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (reader) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > 4096) throw new Error('derived_upload_response_limit');
            chunks.push(next.value);
          }
        } finally {
          await reader?.cancel().catch(() => undefined);
          reader?.releaseLock();
        }
        if (!response.ok) throw new Error('derived_upload_rejected');
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          object: unknown;
        };
        return LocalFileObjectSchema.parse(body.object);
      } catch {
        // Bytes may already be committed. Redeliver evidence; never re-execute.
        throw new FileDerivationError('FILE_DERIVATION_UPLOAD_UNKNOWN', true);
      }
    },
  };
}
