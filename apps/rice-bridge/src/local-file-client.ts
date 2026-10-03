import {
  LocalFileObjectSchema,
  localFileCapabilities,
  type LocalFilePayload,
} from '@allrice/contracts';
import { bridgeRequest } from './client.js';
import type { BridgeJournal } from './journal.js';
import { LocalFileError, type LocalFileTransport } from './local-files.js';

export function localFileHttpTransport(input: {
  server: string;
  token: string;
  kind: 'command' | 'operation';
  id: string;
  leaseToken: string;
  signal?: AbortSignal;
}) {
  const path = `/api/v1/bridge/device/file-transfers/${input.kind}/${input.id}`;
  const headers = {
    authorization: `Bearer ${input.token}`,
    'x-allrice-lease': input.leaseToken,
  };
  const signal = () =>
    AbortSignal.any([
      ...(input.signal ? [input.signal] : []),
      AbortSignal.timeout(35_000),
    ]);
  let permittedAt = 0;
  const authorize = async (force = false) => {
    if (input.signal?.aborted) return false;
    if (!force && Date.now() - permittedAt < 1000) return true;
    try {
      const response = await fetch(
        new URL(`${path}?action=authorize`, input.server),
        {
          redirect: 'error',
          headers,
          signal: signal(),
        },
      );
      if (!response.ok) return false;
      const body = (await response.json()) as { authorized?: boolean };
      if (body.authorized !== true) return false;
      permittedAt = Date.now();
      return true;
    } catch {
      return false;
    }
  };
  const transport: LocalFileTransport = {
    async download(object) {
      const response = await fetch(
        new URL(`${path}?action=download`, input.server),
        { redirect: 'error', headers, signal: signal() },
      );
      if (
        !response.ok ||
        !response.body ||
        response.headers.get('x-allrice-checksum') !== object.checksum ||
        Number(response.headers.get('content-length')) !== object.sizeBytes
      )
        throw new LocalFileError('FILE_DOWNLOAD_REJECTED');
      return response.body;
    },
    async upload(file, fileName, bytes) {
      try {
        const response = await fetch(new URL(path, input.server), {
          method: 'POST',
          redirect: 'error',
          headers: {
            ...headers,
            'content-type': 'application/octet-stream',
            'x-allrice-file': encodeURIComponent(
              JSON.stringify({ version: file, fileName }),
            ),
          },
          body: bytes,
          signal: signal(),
          duplex: 'half',
        } as RequestInit & { duplex: 'half' });
        const reader = response.body?.getReader();
        let length = 0;
        const chunks: Uint8Array[] = [];
        try {
          while (reader) {
            const next = await reader.read();
            if (next.done) break;
            length += next.value.byteLength;
            if (length > 4096)
              throw new LocalFileError('FILE_UPLOAD_RESPONSE_TOO_LARGE');
            chunks.push(next.value);
          }
        } finally {
          await reader?.cancel().catch(() => undefined);
          reader?.releaseLock();
        }
        if (!response.ok) throw new LocalFileError('FILE_UPLOAD_REJECTED');
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          object: unknown;
        };
        return LocalFileObjectSchema.parse(body.object);
      } catch {
        throw new LocalFileError('FILE_UPLOAD_UNKNOWN', true);
      }
    },
  };
  return { transport, authorize };
}

export async function flushLocalFileCommands(input: {
  server: string;
  token: string;
  journal: BridgeJournal;
  signal?: AbortSignal;
}) {
  for (const command of await input.journal.pendingFileCommands()) {
    await bridgeRequest({
      server: input.server,
      token: input.token,
      method: 'POST',
      path: `/api/v1/bridge/device/commands/${command.id}/complete`,
      body: command.receipt,
      signal: input.signal,
      maximumResponseBytes: 4096,
    });
    await input.journal.acknowledgeFileCommand(command.id);
  }
}

export function isLocalFilePayload(payload: {
  capability: string;
}): payload is LocalFilePayload {
  return localFileCapabilities.some(
    (capability) => capability === payload.capability,
  );
}
