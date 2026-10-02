import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RuntimeBridgeDispatchSchema,
  RuntimeLocalPdfPayloadSchema,
  RuntimeLocalPdfResultSchema,
  pdfReadReleaseForPlatform,
  type RuntimeLocalPdfResult,
} from '@allrice/contracts';
import { localPdfHttpTransport } from './local-pdf-client.js';
import { pdfResultMatchesPayload } from './local-pdf-proof.js';
import { BridgeJournal, bridgeDigest } from './journal.js';
import { fixtureId, journalDispatch } from './journal-fixtures.js';
import { RuntimeBridgeOperationClient } from './operation-client.js';
import type { LocalPdfRunner } from './local-pdf-runner.js';
import type { bridgeRequest } from './client.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
const bytes = Buffer.from('%PDF-1.4\nsynthetic transport bytes');
const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const payload = RuntimeLocalPdfPayloadSchema.parse({
  capability: 'local.pdf.read',
  arguments: {
    path: '.',
    origin: {
      toolName: 'workspace.document.read',
      callId: 'original-read-call',
      argumentsDigest: `sha256:${'a'.repeat(64)}`,
    },
    source: {
      objectId: fixtureId(31),
      checksum,
      sizeBytes: bytes.length,
      mediaType: 'application/pdf',
      artifactVersionId: fixtureId(32),
      artifactVersion: 2,
    },
    fileName: '中文 来源.pdf',
    options: { pages: [2, 2], includeStructure: true },
    profileVersion: 1,
    pins: pdfReadReleaseForPlatform('macos-x64')!.pins,
    limits: {
      inputBytes: 20 * 1024 * 1024,
      resultBytes: 400_000,
      timeoutMs: 30_000,
      resourceBudgetBytes: 512 * 1024 * 1024,
    },
  },
});
const result = RuntimeLocalPdfResultSchema.parse({
  type: 'local_pdf_read_result_v1',
  origin: payload.arguments.origin,
  source: payload.arguments.source,
  profileVersion: 1,
  pins: payload.arguments.pins,
  document: {
    kind: 'pdf',
    text: '第2页',
    units: [{ label: '第 2 页', text: '第2页', pageNumber: 2 }],
    truncated: true,
    totalPages: 3,
    requestedPages: [2],
    nextPages: [3],
    quality: 'digital_text',
    warnings: [],
    warningCodes: [],
    parser: { name: 'pdf-parse', version: '2.4.5' },
    tables: [],
  },
  error: null,
  process: {
    stopped: true,
    exitCode: 0,
    reason: 'completed',
    memoryEnforcement: 'watchdog',
    observedPeakRssBytes: 100_000_000,
  },
});

async function fixture() {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-pdf-bridge-')),
  );
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const dispatch = journalDispatch(dir);
  const fingerprint = createHash('sha256')
    .update(`allrice-readonly-pdf-v1:${fixtureId(11)}`)
    .digest('hex');
  const pdf = RuntimeBridgeDispatchSchema.parse({
    ...dispatch,
    payload,
    grantRootFingerprint: fingerprint,
    snapshot: {
      ...dispatch.snapshot,
      binding: {
        ...dispatch.snapshot.binding,
        action: 'local.pdf.read',
        inputDigest: bridgeDigest(payload),
        execution: {
          ...dispatch.snapshot.binding.execution,
          scopeDigest: `sha256:${fingerprint}`,
        },
      },
    },
  });
  const journal = await BridgeJournal.open({
    directory: join(dir, 'journal'),
    server: 'https://bridge.invalid',
    deviceId: fixtureId(11),
  });
  cleanups.push(() => journal.close());
  return {
    dir,
    dispatch: pdf,
    journal,
    config: {
      server: 'https://bridge.invalid/',
      deviceId: fixtureId(11),
      deviceName: 'Read-only device',
      grants: [],
    },
  };
}

describe('fixed read-only PDF byte transport', () => {
  it.each(['correct', 'changed', 'oversized', 'headers'] as const)(
    'uses the original UUID byte route and validates %s response',
    async (mode) => {
      const requested: string[] = [];
      const server = createServer((req, res) => {
        requested.push(req.url!);
        expect(req.headers.authorization).toBe('Bearer own-device');
        expect(req.headers['x-allrice-lease']).toBe('own-lease');
        res.setHeader(
          'x-allrice-checksum',
          mode === 'headers' ? `sha256:${'0'.repeat(64)}` : checksum,
        );
        res.setHeader('content-length', bytes.length);
        res.end(
          mode === 'changed'
            ? Buffer.alloc(bytes.length)
            : mode === 'oversized'
              ? Buffer.concat([bytes, bytes])
              : bytes,
        );
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      cleanups.push(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw Error();
      const transport = localPdfHttpTransport({
        server: `http://127.0.0.1:${address.port}`,
        token: 'own-device',
        id: fixtureId(6),
        leaseToken: 'own-lease',
      });
      const task = transport.download(
        payload.arguments.source,
        AbortSignal.timeout(2000),
      );
      // HTTP content-length prevents bytes beyond the declared response from
      // becoming input; exactly the verified declared bytes may be returned.
      if (mode === 'correct' || mode === 'oversized')
        expect(await task).toEqual(bytes);
      else await expect(task).rejects.toThrow('PDF_SOURCE_CHANGED');
      expect(requested).toEqual([
        `/api/v1/bridge/device/file-transfers/operation/${fixtureId(6)}?action=download&objectId=${fixtureId(31)}`,
      ]);
      expect(Object.keys(transport)).toEqual(['download']);
    },
  );

  it('aborts a stalled response reader promptly, rather than waiting for its next chunk', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('x-allrice-checksum', checksum);
      res.setHeader('content-length', bytes.length);
      res.write(bytes.subarray(0, 2));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw Error();
    const controller = new AbortController();
    const transport = localPdfHttpTransport({
      server: `http://127.0.0.1:${address.port}`,
      token: 'own-device',
      id: fixtureId(6),
      leaseToken: 'own-lease',
    });
    const started = Date.now(),
      task = transport.download(payload.arguments.source, controller.signal);
    const timer = setTimeout(() => controller.abort(), 30);
    try {
      await expect(task).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      clearTimeout(timer);
    }
  });
});

describe('PDF operation receipt and unknown reconciliation', () => {
  it('uses the independent readonly grant with no folder, Node or Python runner, once per call', async () => {
    const f = await fixture();
    const execute = vi.fn(async () => result);
    const runner = {
      execute,
      acknowledge: vi.fn(),
    } as unknown as LocalPdfRunner;
    const request = vi.fn(async () => ({
      mayExecute: true,
      snapshot: { ...f.dispatch.snapshot, status: 'running' },
    }));
    const client = new RuntimeBridgeOperationClient({
      config: f.config,
      token: 'token',
      journal: f.journal,
      pdfRunner: runner,
      request: request as typeof bridgeRequest,
    });
    await client.handle(f.dispatch);
    await client.handle(f.dispatch);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect((await f.journal.pending()).at(-1)).toMatchObject({
      signal: {
        type: 'operation.outcome',
        result: { status: 'succeeded', effects: 'none' },
      },
      evidence: { output: result },
    });
  });

  it.each(['PDF_ATTEMPT_EXISTS', 'PDF_RESULT_UNKNOWN'])(
    'retains %s as unknown, never a fabricated preflight failure',
    async (code) => {
      const f = await fixture(),
        execute = vi.fn(async () => {
          throw Error(code);
        });
      const request = vi.fn(async () => ({
        mayExecute: true,
        snapshot: { ...f.dispatch.snapshot, status: 'running' },
      }));
      const client = new RuntimeBridgeOperationClient({
        config: f.config,
        token: 'token',
        journal: f.journal,
        pdfRunner: { execute } as unknown as LocalPdfRunner,
        request: request as typeof bridgeRequest,
      });
      await client.handle(f.dispatch);
      await client.handle(f.dispatch);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await f.journal.unknownLocalPdfOperations()).toHaveLength(1);
      expect((await f.journal.pending()).at(-1)?.signal.type).toBe(
        'operation.uncertain',
      );
    },
  );

  it('reconciles a bound stopped checkpoint without executing again; altered source or pages stay unknown', async () => {
    const f = await fixture();
    await f.journal.receive(f.dispatch);
    await f.journal.begin(fixtureId(6));
    await f.journal.uncertain(fixtureId(6), 'receipt_missing');
    const changed = {
      ...result,
      source: { ...result.source, artifactVersion: 3 },
    };
    await expect(
      f.journal.reconcileLocalPdf(fixtureId(6), changed),
    ).rejects.toThrow('JOURNAL_RECOVERY_MISMATCH');
    expect(
      pdfResultMatchesPayload(payload, {
        ...result,
        document: { ...result.document!, requestedPages: [1] },
      }),
    ).toBe(false);
    await f.journal.reconcileLocalPdf(fixtureId(6), result);
    expect(await f.journal.unknownLocalPdfOperations()).toHaveLength(0);
    expect((await f.journal.pending()).at(-1)).toMatchObject({
      signal: {
        type: 'operation.outcome',
        result: { status: 'succeeded', effects: 'none' },
      },
    });
    expect(await f.journal.receive(f.dispatch)).toBe('duplicate');
  });

  it('records a canceled parser only with the typed physically stopped result', async () => {
    const f = await fixture();
    const canceled: RuntimeLocalPdfResult = {
      ...result,
      document: null,
      error: { code: 'PDF_CANCELED', message: '取消' },
      process: { ...result.process, reason: 'canceled', exitCode: null },
    };
    const request = vi.fn(async () => ({
      mayExecute: true,
      snapshot: { ...f.dispatch.snapshot, status: 'running' },
    }));
    await new RuntimeBridgeOperationClient({
      config: f.config,
      token: 'token',
      journal: f.journal,
      pdfRunner: { execute: async () => canceled } as unknown as LocalPdfRunner,
      request: request as typeof bridgeRequest,
    }).handle(f.dispatch);
    expect((await f.journal.pending()).at(-1)).toMatchObject({
      signal: { type: 'operation.stopped', effects: 'none' },
      evidence: { output: canceled },
    });
  });
});
