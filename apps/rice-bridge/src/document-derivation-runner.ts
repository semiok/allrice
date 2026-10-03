import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import {
  DocumentDerivationRequestSchema,
  FileDerivationContentSchema,
  fileDerivationMediaType,
  localFileMaximumBytes,
  type DocumentDerivationRequest,
} from '@allrice/contracts';
import { configPath } from './config.js';
import { prepareCredentialDirectory } from './credential-files.js';
import { inspectFixedPdfResources } from './local-pdf-resources.js';
import { runPdfGuardian } from './local-pdf-runner.js';
import type { DocumentTransformSource } from './document-transforms.js';

const outputSchema = z
  .object({
    file: FileDerivationContentSchema.extend({
      bytesBase64: z.string().max(12_000_000),
    })
      .strict()
      .nullable(),
    error: z
      .object({ code: z.string().max(160) })
      .strict()
      .nullable(),
  })
  .strict();
export class DocumentDerivationError extends Error {
  constructor(
    readonly code: string,
    readonly unknown: boolean,
    cause?: unknown,
  ) {
    super(code, { cause });
  }
}

/** Fixed SEA reader, native isolation and physical supervision from PDF PR2a.
 * Neither a model argument nor a folder path selects executable code. */
export async function runDocumentDerivation(
  sources: readonly DocumentTransformSource[],
  requestInput: DocumentDerivationRequest,
  controls: { signal: AbortSignal; authorize: () => Promise<boolean> },
) {
  const request = DocumentDerivationRequestSchema.parse(requestInput);
  controls.signal.throwIfAborted();
  if (!(await controls.authorize()))
    throw Error('DOCUMENT_TRANSFORM_AUTHORITY_LOST');
  const root = configPath() + '.document-transforms';
  await prepareCredentialDirectory(root);
  const directory = join(root, randomUUID());
  const body = Buffer.from(
    JSON.stringify({
      sources: sources.map((s) => ({
        path: s.path,
        bytesBase64: Buffer.from(s.bytes).toString('base64'),
      })),
    }),
  );
  if (body.length > 12_200_000) throw Error('DOCUMENT_TRANSFORM_LIMIT');
  const payloadDigest =
    'sha256:' +
    createHash('sha256')
      .update(JSON.stringify(request))
      .update(body)
      .digest('hex');
  const result = await runPdfGuardian({
    resources: inspectFixedPdfResources(),
    directory,
    payloadDigest,
    reader: { mode: 'transform', request },
    bytes: body,
    signal: controls.signal,
    maintainLease: controls.authorize,
  }).catch((error) => {
    throw new DocumentDerivationError(
      'DOCUMENT_TRANSFORM_PROCESS_UNKNOWN',
      true,
      error,
    );
  });
  if (!result.stopped)
    throw new DocumentDerivationError(
      'DOCUMENT_TRANSFORM_PROCESS_UNKNOWN',
      true,
    );
  try {
    if (result.reason !== 'completed')
      throw Error('DOCUMENT_TRANSFORM_' + result.reason.toUpperCase());
    const output = outputSchema.parse(result.reader);
    if (output.error || !output.file)
      throw Error(output.error?.code ?? 'DOCUMENT_TRANSFORM_INVALID_RESULT');
    if (result.exitCode !== 0) throw Error('DOCUMENT_TRANSFORM_INVALID_RESULT');
    const file = output.file,
      bytes = Buffer.from(file.bytesBase64, 'base64');
    if (
      bytes.toString('base64') !== file.bytesBase64 ||
      bytes.length !== file.sizeBytes ||
      bytes.length > localFileMaximumBytes ||
      file.checksum !==
        'sha256:' + createHash('sha256').update(bytes).digest('hex') ||
      file.fileName !== request.fileName ||
      file.mediaType !== fileDerivationMediaType(request)
    )
      throw Error('DOCUMENT_TRANSFORM_INVALID_RESULT');
    controls.signal.throwIfAborted();
    if (!(await controls.authorize()))
      throw Error('DOCUMENT_TRANSFORM_AUTHORITY_LOST');
    return {
      bytes,
      processing: {
        stopped: true as const,
        reason: 'completed' as const,
        guardianPid: result.guardianPid,
        readerPid: result.readerPid,
        observedPeakRssBytes: result.observedPeakRssBytes,
      },
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
