import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { z } from 'zod';
import {
  RuntimeLocalPdfPayloadSchema,
  RuntimeLocalPdfProfileSchema,
  RuntimeLocalPdfResultSchema,
  UuidSchema,
  runtimeContractEqual,
  localPdfInputBytesV1,
  localPdfResultBytesV1,
  localPdfTimeoutMsV1,
  localPdfMemoryBudgetBytesV1,
  pdfReadReleaseForPlatform,
  type DocumentDerivationRequest,
  localPdfProfileMatchesRelease,
  type RuntimeLocalPdfPayload,
  type RuntimeLocalPdfProfile,
  type RuntimeLocalPdfResult,
} from '@allrice/contracts';
import {
  inspectFixedPdfResources,
  type FixedPdfResources,
} from './local-pdf-resources.js';
import {
  prepareCredentialDirectory,
  readCredentialRecordFile,
  writeCredentialRecordFile,
} from './credential-files.js';
import { bridgeDigest } from './journal.js';
import type { LocalPdfTransport } from './local-pdf-client.js';
import { pdfResultMatchesPayload } from './local-pdf-proof.js';

const guardianResultSchema = z
  .object({
    version: z.literal(1),
    nonce: z.string().uuid(),
    payloadDigest: z.string(),
    guardianPid: z.number().int().min(2),
    parentPid: z.number().int().min(2),
    readerPid: z.number().int().min(2),
    stopped: z.boolean(),
    exitCode: z.number().int().nullable(),
    reason: z.enum([
      'completed',
      'canceled',
      'timeout',
      'memory_limit',
      'output_limit',
      'process_unknown',
    ]),
    observedPeakRssBytes: z.number().int().nonnegative(),
    reader: z.unknown(),
  })
  .strict();
type GuardianResult = z.infer<typeof guardianResultSchema>;

function gone(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Actual native helper process, bounded stdout and nonce-bound checkpoint.
 * EOF/lease loss is physical cancellation; no invocation is ever replayed. */
export async function runPdfGuardian(input: {
  resources: FixedPdfResources;
  directory: string;
  payloadDigest: string;
  reader: {
    mode:
      'read' | 'isolation_probe' | 'exec_probe' | 'stop_probe' | 'transform';
    request?: DocumentDerivationRequest;
    options?: {
      pages?: number[];
      maximumCharacters?: number;
      includeStructure?: boolean;
    };
    canary?: string;
    newFile?: string;
  };
  bytes: Buffer;
  signal?: AbortSignal;
  maintainLease: () => Promise<boolean>;
}): Promise<GuardianResult> {
  input.signal?.throwIfAborted();
  if (
    input.bytes.length > localPdfInputBytesV1 ||
    !(await input.maintainLease())
  )
    throw Error('PDF_EXECUTION_REVOKED');
  await mkdir(input.directory, { mode: 0o700 }).catch((error) => {
    if (error.code === 'EEXIST') throw Error('PDF_ATTEMPT_EXISTS');
    throw error;
  });
  await mkdir(join(input.directory, 'empty'), { mode: 0o700 });
  const nonce = randomUUID();
  await writeCredentialRecordFile(
    input.directory,
    'identity.json',
    JSON.stringify({ version: 1, nonce, payloadDigest: input.payloadDigest }),
  );
  const child = spawn(input.resources.guardian, [input.directory], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
  });
  const close = once(child, 'close');
  const maximumResultBytes =
    input.reader.mode === 'transform' ? 12_200_000 : 512_000;
  let outputBytes = 0,
    oversized = false;
  const chunks: Buffer[] = [];
  child.stdout.on('data', (bytes: Buffer) => {
    outputBytes += bytes.length;
    if (outputBytes <= maximumResultBytes) chunks.push(bytes);
    else {
      oversized = true;
      child.stdin.end();
    }
  });
  child.stderr.resume();
  child.stdin.on('error', () => undefined);
  const abort = () => child.stdin.end();
  input.signal?.addEventListener('abort', abort, { once: true });
  child.stdin.write(
    JSON.stringify({
      version: 1,
      nonce,
      payloadDigest: input.payloadDigest,
      core: input.resources.core,
      resources: input.resources.root,
      inputBytes: input.bytes.length,
      reader: input.reader,
    }) + '\n',
  );
  child.stdin.write(input.bytes);
  let checking = false;
  const pulse = setInterval(() => {
    if (checking || child.stdin.destroyed || child.stdin.writableEnded) return;
    checking = true;
    void input
      .maintainLease()
      .then((allowed) => {
        if (!allowed || input.signal?.aborted) child.stdin.end();
        else child.stdin.write('.');
      })
      .catch(() => child.stdin.end())
      .finally(() => {
        checking = false;
      });
  }, 500);
  const fallback = setTimeout(() => {
    child.stdin.end();
  }, localPdfTimeoutMsV1 + 1000);
  try {
    await close;
    if (oversized) throw Error('PDF_RESULT_UNKNOWN');
    const result = guardianResultSchema.parse(
      JSON.parse(Buffer.concat(chunks).toString('utf8')),
    );
    if (
      result.nonce !== nonce ||
      result.payloadDigest !== input.payloadDigest ||
      result.parentPid !== process.pid ||
      result.guardianPid !== child.pid ||
      !result.stopped ||
      !gone(result.readerPid)
    )
      throw Error('PDF_RESULT_UNKNOWN');
    const stored = await readCredentialRecordFile(
      input.directory,
      'result.json',
      { maxBytes: maximumResultBytes },
    );
    if (!stored || !runtimeContractEqual(JSON.parse(stored), result))
      throw Error('PDF_RESULT_UNKNOWN');
    return result;
  } finally {
    clearInterval(pulse);
    clearTimeout(fallback);
    input.signal?.removeEventListener('abort', abort);
    child.stdin.end();
  }
}

function boundResult(
  payload: RuntimeLocalPdfPayload,
  result: GuardianResult,
): RuntimeLocalPdfResult {
  const reader = z
    .object({
      document: z.unknown().nullable(),
      error: z.object({ code: z.string(), message: z.string() }).nullable(),
    })
    .strict()
    .safeParse(result.reader);
  const completed =
    result.stopped &&
    result.reason === 'completed' &&
    result.exitCode === 0 &&
    reader.success &&
    reader.data.document !== null &&
    reader.data.error === null;
  const reason = completed
    ? 'completed'
    : result.reason === 'completed'
      ? 'parse_failed'
      : result.reason;
  return RuntimeLocalPdfResultSchema.parse({
    type: 'local_pdf_read_result_v1',
    origin: payload.arguments.origin,
    source: payload.arguments.source,
    profileVersion: payload.arguments.profileVersion,
    pins: payload.arguments.pins,
    document: completed && reader.success ? reader.data.document : null,
    error: completed
      ? null
      : reader.success && reader.data.error
        ? reader.data.error
        : {
            code: `PDF_${reason.toUpperCase()}`,
            message: '本地 PDF 读取未完成；未自动换端或重试。',
          },
    process: {
      stopped: result.stopped,
      exitCode: result.exitCode,
      reason,
      memoryEnforcement: 'watchdog',
      observedPeakRssBytes: result.observedPeakRssBytes,
    },
  });
}

export class LocalPdfRunner {
  private readyProfile?: RuntimeLocalPdfProfile;
  constructor(private readonly input: { directory: string }) {}

  async preflight(): Promise<RuntimeLocalPdfProfile> {
    const resources = inspectFixedPdfResources();
    const release = pdfReadReleaseForPlatform(resources.platform);
    if (
      !this.readyProfile ||
      !release ||
      !localPdfProfileMatchesRelease(this.readyProfile, release) ||
      !runtimeContractEqual(resources.pins, this.readyProfile.pins)
    )
      throw Error('PDF_RESOURCE_CHANGED');
    return this.readyProfile;
  }

  async probe(signal?: AbortSignal): Promise<RuntimeLocalPdfProfile> {
    const resources = inspectFixedPdfResources();
    // ARM packaging is not native acceptance. Do not advertise unverified OS
    // and architecture merely because fixed resources are present.
    if (
      process.platform !== 'darwin' ||
      !pdfReadReleaseForPlatform(resources.platform)?.nativeSupported
    )
      throw Error('PDF_NATIVE_PLATFORM_UNVERIFIED');
    await prepareCredentialDirectory(this.input.directory);
    const root = await realpath(this.input.directory),
      id = randomUUID();
    const canary = join(root, `canary-${id}`),
      newFile = join(root, `escape-${id}`);
    const marker = `PDF_READ_ONLY_PROBE:${id}`;
    await writeFile(canary, marker, { flag: 'wx', mode: 0o600 });
    const directories: string[] = [];
    let successful = false;
    const run = (
      mode: 'read' | 'isolation_probe' | 'exec_probe' | 'stop_probe',
      bytes = Buffer.alloc(0),
      localSignal = signal,
    ) => {
      const directory = join(root, `probe-${randomUUID()}`);
      directories.push(directory);
      return runPdfGuardian({
        resources,
        directory,
        payloadDigest: `sha256:${createHash('sha256').update(mode).digest('hex')}`,
        reader: {
          mode,
          ...(mode === 'isolation_probe'
            ? { canary, newFile }
            : mode === 'read'
              ? { options: { includeStructure: true } }
              : {}),
        },
        bytes,
        signal: localSignal,
        maintainLease: async () => !localSignal?.aborted,
      });
    };
    try {
      const parsed = await run(
        'read',
        await readFile(join(resources.root, 'probe.pdf')),
      );
      const content = z
        .object({
          document: z
            .object({
              quality: z.literal('digital_text'),
              tables: z.array(z.unknown()).min(1),
              text: z.string(),
            })
            .passthrough(),
          error: z.null(),
        })
        .strict()
        .parse(parsed.reader);
      if (
        parsed.exitCode !== 0 ||
        !parsed.stopped ||
        !content.document.text.includes('00123')
      )
        throw Error('PDF_PARSER_PROBE_FAILED');
      const isolated = await run('isolation_probe');
      const isolation = z
        .object({
          isolation: z
            .object({
              deniedHostRead: z.literal(true),
              deniedHostWrite: z.literal(true),
              deniedNetwork: z.literal(true),
              deniedChildExecution: z.literal(true),
            })
            .strict(),
        })
        .strict()
        .parse(isolated.reader).isolation;
      if (
        isolated.exitCode !== 0 ||
        !isolated.stopped ||
        (await readFile(canary, 'utf8')) !== marker ||
        (await lstat(newFile).then(
          () => true,
          (error) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          },
        ))
      )
        throw Error('PDF_ISOLATION_PROBE_FAILED');
      const execDenied = await run('exec_probe');
      const execDiagnostics = await readCredentialRecordFile(
        directories.at(-1)!,
        'diagnostic.json',
        { maxBytes: 100_000 },
      );
      if (
        !execDenied.stopped ||
        execDenied.exitCode === 0 ||
        !runtimeContractEqual(execDenied.reader, { execAttempt: true }) ||
        !execDiagnostics ||
        !String(JSON.parse(execDiagnostics).stderr).includes(
          'process.execve failed with error code EPERM',
        )
      )
        throw Error('PDF_EXEC_PROBE_FAILED');
      const cancel = new AbortController();
      const timer = setTimeout(() => cancel.abort(), 500);
      let stopped;
      try {
        stopped = await run(
          'stop_probe',
          Buffer.alloc(0),
          AbortSignal.any([cancel.signal, ...(signal ? [signal] : [])]),
        );
      } finally {
        clearTimeout(timer);
      }
      if (!stopped.stopped || stopped.reason !== 'canceled')
        throw Error('PDF_STOP_PROBE_FAILED');
      this.readyProfile = RuntimeLocalPdfProfileSchema.parse({
        contractVersion: 1,
        profileVersion: 1,
        backend: 'native-seatbelt-v1',
        platform: resources.platform,
        pins: resources.pins,
        available: true,
        readOnly: true,
        ocr: false,
        stopConfirmed: true,
        isolation: {
          network: 'none',
          hostFileAccess: 'none',
          childExecution: 'none',
          memoryEnforcement: 'watchdog',
          resourceBudgetBytes: localPdfMemoryBudgetBytesV1,
          watchdogThresholdBytes: localPdfMemoryBudgetBytesV1,
          timeoutMs: localPdfTimeoutMsV1,
          ...isolation,
        },
        limits: {
          inputBytes: localPdfInputBytesV1,
          resultBytes: localPdfResultBytesV1,
          maximumPages: 10,
          maximumCharacters: 300_000,
        },
      });
      const release = pdfReadReleaseForPlatform(resources.platform);
      if (
        !release ||
        !localPdfProfileMatchesRelease(this.readyProfile, release)
      ) {
        this.readyProfile = undefined;
        throw Error('PDF_RESOURCE_CHANGED');
      }
      successful = true;
      return this.readyProfile;
    } finally {
      await rm(canary, { force: true });
      if (successful)
        for (const directory of directories)
          await rm(directory, { recursive: true, force: true });
    }
  }

  async execute(
    input: RuntimeLocalPdfPayload,
    options: {
      attemptId: string;
      transport: LocalPdfTransport;
      signal?: AbortSignal;
      maintainLease: () => Promise<boolean>;
    },
  ): Promise<RuntimeLocalPdfResult> {
    const payload = RuntimeLocalPdfPayloadSchema.parse(input),
      resources = inspectFixedPdfResources();
    if (
      !this.readyProfile?.available ||
      !runtimeContractEqual(resources.pins, payload.arguments.pins) ||
      !runtimeContractEqual(this.readyProfile.pins, resources.pins)
    )
      throw Error('PDF_RESOURCE_CHANGED');
    const attemptId = UuidSchema.parse(options.attemptId),
      signal = AbortSignal.any([
        ...(options.signal ? [options.signal] : []),
        AbortSignal.timeout(localPdfTimeoutMsV1),
      ]);
    if (!(await options.maintainLease())) throw Error('PDF_EXECUTION_REVOKED');
    let bytes;
    try {
      bytes = await options.transport.download(
        payload.arguments.source,
        signal,
      );
    } catch (error) {
      if (signal.aborted) throw Error('PDF_EXECUTION_REVOKED');
      throw error;
    }
    if (
      bytes.length !== payload.arguments.source.sizeBytes ||
      `sha256:${createHash('sha256').update(bytes).digest('hex')}` !==
        payload.arguments.source.checksum
    )
      throw Error('PDF_SOURCE_CHANGED');
    const result = await runPdfGuardian({
      resources,
      directory: join(this.input.directory, attemptId),
      payloadDigest: bridgeDigest(payload),
      reader: {
        mode: 'read',
        options: {
          ...(payload.arguments.options.pages
            ? { pages: payload.arguments.options.pages }
            : {}),
          ...(payload.arguments.options.maxCharacters !== undefined
            ? { maximumCharacters: payload.arguments.options.maxCharacters }
            : {}),
          ...(payload.arguments.options.includeStructure !== undefined
            ? { includeStructure: payload.arguments.options.includeStructure }
            : {}),
        },
      },
      bytes,
      signal,
      maintainLease: options.maintainLease,
    });
    const bound = boundResult(payload, result);
    if (!pdfResultMatchesPayload(payload, bound))
      throw Error('PDF_RESULT_UNKNOWN');
    return bound;
  }

  async recover(
    attemptId: string,
    payload: RuntimeLocalPdfPayload,
  ): Promise<RuntimeLocalPdfResult | null> {
    const directory = join(this.input.directory, UuidSchema.parse(attemptId));
    const identity = await readCredentialRecordFile(directory, 'identity.json');
    const text = await readCredentialRecordFile(directory, 'result.json', {
      maxBytes: 512_000,
    });
    if (!identity || !text) return null;
    const before = JSON.parse(identity),
      result = guardianResultSchema.parse(JSON.parse(text));
    if (
      before.nonce !== result.nonce ||
      before.payloadDigest !== bridgeDigest(payload) ||
      result.payloadDigest !== before.payloadDigest ||
      !result.stopped ||
      !gone(result.readerPid)
    )
      return null;
    const bound = boundResult(
      RuntimeLocalPdfPayloadSchema.parse(payload),
      result,
    );
    return pdfResultMatchesPayload(payload, bound) ? bound : null;
  }

  /** A terminal server ACK is the only caller. Missing/unknown/live evidence
   * is retained; pruning never repeats the parser or fabricates an outcome. */
  async acknowledge(attemptId: string) {
    const directory = join(this.input.directory, UuidSchema.parse(attemptId));
    const text = await readCredentialRecordFile(directory, 'result.json', {
      maxBytes: 512_000,
    });
    if (!text) return;
    const result = guardianResultSchema.parse(JSON.parse(text));
    if (result.stopped && gone(result.readerPid))
      await rm(directory, { recursive: true });
  }
}
