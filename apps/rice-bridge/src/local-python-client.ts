import { createHash } from 'node:crypto';
import {
  RuntimeLocalPythonArtifactMetadataSchema,
  RuntimeLocalPythonCollectedArtifactSchema,
  runtimeContractEqual,
  type RuntimeLocalPythonPayload,
  type RuntimeLocalPythonArtifactMetadata,
} from '@allrice/contracts';
import { LocalCommandError } from './local-command-inputs.js';
import {
  inputDownloadNetworkReason,
  inputDownloadAbortReason,
  LocalPythonInputDownloadError,
} from './local-python-download-error.js';

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
      const started = performance.now();
      const deadline = bounded(signal);
      let stage: 'response' | 'body' | 'validation' = 'response';
      let httpStatus: number | null = null;
      let size = 0;
      const failure = (
        code: ConstructorParameters<typeof LocalPythonInputDownloadError>[0],
        reason: string,
      ) =>
        new LocalPythonInputDownloadError(code, {
          objectId: file.objectId,
          stage,
          reason,
          httpStatus,
          expectedBytes: file.sizeBytes,
          receivedBytes: size,
          elapsedMs: Math.max(0, Math.round(performance.now() - started)),
        });
      try {
        const response = await fetch(
          new URL(
            `${base}?action=download&objectId=${file.objectId}`,
            input.server,
          ),
          { redirect: 'error', headers, signal: deadline },
        );
        httpStatus = response.status;
        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => undefined);
          throw failure(
            'INPUT_VERSION_CHANGED',
            !response.ok ? 'http_rejected' : 'body_missing',
          );
        }
        if (
          response.headers.get('x-allrice-checksum') !== file.checksum ||
          Number(response.headers.get('content-length')) !== file.sizeBytes
        ) {
          await response.body.cancel().catch(() => undefined);
          stage = 'validation';
          throw failure(
            'INPUT_VERSION_CHANGED',
            response.headers.get('x-allrice-checksum') !== file.checksum
              ? 'checksum_header'
              : 'content_length',
          );
        }
        stage = 'body';
        const reader = response.body.getReader(),
          chunks: Uint8Array[] = [];
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > file.sizeBytes)
              throw failure('INPUT_LIMIT', 'body_limit');
            chunks.push(next.value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        const bytes = Buffer.concat(chunks);
        stage = 'validation';
        if (
          size !== file.sizeBytes ||
          `sha256:${createHash('sha256').update(bytes).digest('hex')}` !==
            file.checksum
        )
          throw failure(
            'INPUT_VERSION_CHANGED',
            size !== file.sizeBytes ? 'body_size' : 'body_checksum',
          );
        return bytes;
      } catch (error) {
        if (error instanceof LocalPythonInputDownloadError) throw error;
        throw failure(
          signal.aborted ? 'EXECUTION_REVOKED' : 'INPUT_DOWNLOAD_UNAVAILABLE',
          signal.aborted
            ? inputDownloadAbortReason(signal.reason)
            : deadline.aborted
              ? 'timeout'
              : inputDownloadNetworkReason(error),
        );
      }
    },
    async upload(output, metadata, bytes, signal) {
      const parsed = RuntimeLocalPythonArtifactMetadataSchema.parse(metadata);
      if (
        bytes.length !== parsed.sizeBytes ||
        `sha256:${createHash('sha256').update(bytes).digest('hex')}` !==
          parsed.checksum ||
        (output.format === 'png'
          ? !parsed.png ||
            parsed.png.checksum !== parsed.checksum ||
            parsed.validation !== 'trusted_png'
          : parsed.png !== undefined)
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
        !runtimeContractEqual(artifact, {
          ...output,
          ...parsed,
          collected: true,
        })
      )
        throw new LocalCommandError('ARTIFACT_UPLOAD_UNKNOWN');
      return artifact;
    },
  };
}
