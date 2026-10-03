import { readFile, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  DocumentDerivationRequestSchema,
  LocalFilePathSchema,
  localFileMaximumBytes,
} from '@allrice/contracts';
import {
  transformDocuments,
  DocumentTransformError,
} from './document-transforms.js';
import {
  configureTrustedPdfReaderRuntime,
  readPdfDocument,
  PdfReadError,
} from '@allrice/office-runtime/pdf-reader';
import { loadFixedPdfResources } from './local-pdf-resources.js';

async function denied(action: () => unknown | Promise<unknown>) {
  try {
    await action();
    return false;
  } catch (error) {
    return ['EPERM', 'EACCES'].includes(
      (error as NodeJS.ErrnoException).code ?? '',
    );
  }
}

async function deniedNetwork() {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: '1.1.1.1', port: 443 });
    const finish = (blocked: boolean) => {
      socket.destroy();
      resolve(blocked);
    };
    socket.setTimeout(1000, () => finish(false));
    socket.once('connect', () => finish(false));
    socket.once('error', (error) =>
      finish(
        ['EPERM', 'EACCES'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        ),
      ),
    );
  });
}

/** The only internal parser entry. Called before Core/credentials/instance lock.
 * Resource paths are fixed by SEA, and no PDF/HTTP argument selects code. */
export async function runFixedPdfReader() {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 20 * 1024 * 1024 + 16_384) throw Error('PDF_INPUT_LIMIT');
    chunks.push(Buffer.from(chunk));
  }
  const input = Buffer.concat(chunks),
    split = input.indexOf(10);
  if (split < 1 || split > 16_384) throw Error('PDF_INPUT_INVALID');
  const header = JSON.parse(input.subarray(0, split).toString('utf8')) as {
    mode: string;
    request?: unknown;
    options?: {
      pages?: number[];
      maximumCharacters?: number;
      includeStructure?: boolean;
    };
    canary?: string;
    newFile?: string;
  };
  const bytes = input.subarray(split + 1);
  if (header.mode === 'transform') {
    if (Object.keys(header).some((key) => !['mode', 'request'].includes(key)))
      throw Error('DOCUMENT_TRANSFORM_INVALID_REQUEST');
    try {
      const request = DocumentDerivationRequestSchema.parse(header.request);
      const body = z
        .object({
          sources: z
            .array(
              z
                .object({
                  path: LocalFilePathSchema,
                  bytesBase64: z.string().max(12_000_000),
                })
                .strict(),
            )
            .min(1)
            .max(32),
        })
        .strict()
        .parse(JSON.parse(bytes.toString('utf8')));
      const sources = body.sources.map((s) => {
        const value = Buffer.from(s.bytesBase64, 'base64');
        if (value.toString('base64') !== s.bytesBase64)
          throw Error('DOCUMENT_TRANSFORM_INVALID_SOURCE');
        return { path: s.path, bytes: value };
      });
      if (
        sources.reduce((n, s) => n + s.bytes.length, 0) > localFileMaximumBytes
      )
        throw Error('DOCUMENT_TRANSFORM_LIMIT');
      const transformed = await transformDocuments(
        sources,
        request.kind === 'pdf_merge' ||
          request.kind === 'pdf_extract' ||
          request.kind === 'pdf_rotate'
          ? { ...request, name: request.fileName }
          : {
              ...request,
              ...(request.quality === undefined
                ? {}
                : { quality: Math.round(request.quality * 100) }),
            },
      );
      if (transformed.length !== 1)
        throw Error('DOCUMENT_TRANSFORM_INVALID_RESULT');
      const output = transformed[0]!;
      process.stdout.write(
        JSON.stringify({
          file: {
            fileName: request.fileName,
            mediaType: output.mediaType,
            sizeBytes: output.bytes.length,
            checksum:
              'sha256:' +
              createHash('sha256').update(output.bytes).digest('hex'),
            bytesBase64: Buffer.from(output.bytes).toString('base64'),
          },
          error: null,
        }) + '\n',
      );
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          file: null,
          error: {
            code:
              error instanceof DocumentTransformError
                ? error.code
                : 'DOCUMENT_TRANSFORM_INVALID_SOURCE',
          },
        }) + '\n',
      );
      process.exitCode = 1;
    }
    return;
  }
  if (header.mode === 'stop_probe') {
    setInterval(() => undefined, 1000);
    return;
  }
  if (header.mode === 'exec_probe') {
    if (typeof process.execve !== 'function')
      throw Error('PDF_EXEC_PROBE_UNAVAILABLE');
    // Node aborts natively when execve is denied. Flush a fixed marker first;
    // the guardian checks its private diagnostic for actual OS EPERM, not a
    // timeout, connectivity error or an invented JavaScript success flag.
    process.stdout.write(JSON.stringify({ execAttempt: true }) + '\n', () =>
      process.execve!('/bin/sh', ['/bin/sh', '-c', 'exit 0'], {}),
    );
    return;
  }
  if (header.mode === 'isolation_probe') {
    if (typeof header.canary !== 'string' || typeof header.newFile !== 'string')
      throw Error('PDF_PROBE_INVALID');
    const child = spawnSync('/bin/sh', ['-c', 'exit 0'], { timeout: 1000 });
    const result = {
      deniedHostRead: await denied(() => readFile(header.canary!)),
      deniedHostWrite:
        (await denied(() => writeFile(header.canary!, 'PDF_PROBE_ESCAPE'))) &&
        (await denied(() =>
          writeFile(header.newFile!, 'PDF_PROBE_ESCAPE', { flag: 'wx' }),
        )),
      deniedNetwork: await deniedNetwork(),
      deniedChildExecution: ['EPERM', 'EACCES'].includes(
        (child.error as NodeJS.ErrnoException | undefined)?.code ?? '',
      ),
    };
    process.stdout.write(JSON.stringify({ isolation: result }) + '\n');
    return;
  }
  if (
    header.mode !== 'read' ||
    Object.keys(header).some((key) => !['mode', 'options'].includes(key))
  )
    throw Error('PDF_INPUT_INVALID');
  const runtime = loadFixedPdfResources();
  configureTrustedPdfReaderRuntime(runtime);
  try {
    const document = await readPdfDocument({
      bytes: new Uint8Array(bytes),
      ...header.options,
    });
    process.stdout.write(JSON.stringify({ document, error: null }) + '\n');
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        document: null,
        error: {
          code: error instanceof PdfReadError ? error.code : 'PDF_PARSE_FAILED',
          message:
            error instanceof PdfReadError
              ? error.message
              : '本地固定 PDF 解析失败。',
        },
      }) + '\n',
    );
    process.exitCode = 1;
  }
}
