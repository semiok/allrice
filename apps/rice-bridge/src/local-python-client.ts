import { createHash } from 'node:crypto';
import {
  RuntimeLocalPythonArtifactMetadataSchema,
  RuntimeLocalPythonCollectedArtifactSchema,
  type RuntimeLocalPythonPayload,
  type RuntimeLocalPythonArtifactMetadata,
} from '@allrice/contracts';
import { LocalCommandError } from './local-command-inputs.js';

export interface LocalPythonTransport {
  download(
    input: RuntimeLocalPythonPayload['arguments']['inputs'][number],
    signal: AbortSignal,
  ): Promise<Buffer>;
  upload(
    output: RuntimeLocalPythonPayload['arguments']['outputs'][number],
    metadata: RuntimeLocalPythonArtifactMetadata,
    bytes: Buffer,
    signal: AbortSignal,
  ): Promise<
    RuntimeLocalPythonPayload['arguments']['outputs'][number] &
      RuntimeLocalPythonArtifactMetadata & { collected: true }
  >;
}

/** Only immutable, server-declared objects. No model URL, host path or base64. */
export function localPythonHttpTransport(input: {
  server: string;
  token: string;
  id: string;
  leaseToken: string;
}): LocalPythonTransport {
  const base = `/api/v1/bridge/device/file-transfers/operation/${input.id}`;
  const headers = {
    authorization: `Bearer ${input.token}`,
    'x-allrice-lease': input.leaseToken,
  };
  const bounded = (signal: AbortSignal) =>
    AbortSignal.any([signal, AbortSignal.timeout(35_000)]);
  return {
    async download(file, signal) {
      const response = await fetch(
        new URL(
          `${base}?action=download&objectId=${file.objectId}`,
          input.server,
        ),
        { redirect: 'error', headers, signal: bounded(signal) },
      );
      if (
        !response.ok ||
        !response.body ||
        response.headers.get('x-allrice-checksum') !== file.checksum ||
        Number(response.headers.get('content-length')) !== file.sizeBytes
      )
        throw new LocalCommandError('INPUT_VERSION_CHANGED');
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > file.sizeBytes) throw new LocalCommandError('INPUT_LIMIT');
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const bytes = Buffer.concat(chunks);
      if (
        size !== file.sizeBytes ||
        `sha256:${createHash('sha256').update(bytes).digest('hex')}` !==
          file.checksum
      )
        throw new LocalCommandError('INPUT_VERSION_CHANGED');
      return bytes;
    },
    async upload(output, metadata, bytes, signal) {
      const parsed = RuntimeLocalPythonArtifactMetadataSchema.parse(metadata);
      if (
        bytes.length !== parsed.sizeBytes ||
        `sha256:${createHash('sha256').update(bytes).digest('hex')}` !==
          parsed.checksum
      )
        throw new LocalCommandError('ARTIFACT_VERSION_CHANGED');
      const response = await fetch(
        new URL(`${base}?objectId=${output.objectId}`, input.server),
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            ...headers,
            'content-type': 'application/octet-stream',
            'x-allrice-file': encodeURIComponent(JSON.stringify(parsed)),
          },
          body: new Uint8Array(bytes),
          signal: bounded(signal),
        },
      );
      if (!response.ok || !response.body)
        throw new LocalCommandError('ARTIFACT_UPLOAD_UNKNOWN');
      const reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > 4096)
            throw new LocalCommandError('ARTIFACT_UPLOAD_UNKNOWN');
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const artifact = RuntimeLocalPythonCollectedArtifactSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString('utf8')).artifact,
      );
      if (
        Object.entries({ ...output, ...parsed }).some(
          ([key, value]) => artifact[key as keyof typeof artifact] !== value,
        )
      )
        throw new LocalCommandError('ARTIFACT_UPLOAD_UNKNOWN');
      return artifact;
    },
  };
}
