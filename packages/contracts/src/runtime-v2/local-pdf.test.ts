import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PdfReadDocumentSchema,
  RuntimeLocalPdfPayloadSchema,
  RuntimeLocalPdfProfileSchema,
  RuntimeLocalPdfResultSchema,
  WorkspaceDocumentReadArgsSchema,
  localPdfResultMatchesPayload,
} from './local-pdf.ts';
import {
  localPdfProfileMatchesRelease,
  pdfReadReleaseForPlatform,
} from './local-pdf-release.ts';

const release = pdfReadReleaseForPlatform('macos-x64')!;
function fixture() {
  const payload = RuntimeLocalPdfPayloadSchema.parse({
    capability: 'local.pdf.read',
    arguments: {
      path: '.',
      origin: {
        toolName: 'workspace.document.read',
        callId: 'read-physical-pages',
        argumentsDigest: `sha256:${'a'.repeat(64)}`,
      },
      source: {
        objectId: randomUUID(),
        checksum: `sha256:${'b'.repeat(64)}`,
        sizeBytes: 5_000,
        mediaType: 'application/pdf',
        artifactVersionId: randomUUID(),
        artifactVersion: 2,
      },
      fileName: '实际来源.pdf',
      options: { pages: [5, 2, 2], includeStructure: true },
      profileVersion: 1,
      pins: release.pins,
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
    pins: release.pins,
    document: {
      kind: 'pdf',
      text: '第二页原文\n第五页原文',
      truncated: true,
      units: [
        { label: '第2页', pageNumber: 2, text: '第二页原文' },
        { label: '第5页', pageNumber: 5, text: '第五页原文' },
      ],
      warnings: [],
      totalPages: 8,
      requestedPages: [2, 5],
      nextPages: [6, 7, 8],
      quality: 'digital_text',
      warningCodes: [],
      parser: { name: 'pdf-parse', version: '2.4.5' },
      tables: [
        {
          pageNumber: 2,
          tableNumber: 1,
          rows: [{ rowNumber: 1, cells: ['00123', '—', '-200.00'] }],
        },
      ],
    },
    error: null,
    process: {
      stopped: true,
      exitCode: 0,
      reason: 'completed',
      memoryEnforcement: 'watchdog',
      observedPeakRssBytes: 128_000_000,
    },
  });
  return { payload, result };
}

describe('fixed read-only PDF delegation', () => {
  it('keeps original options and raw arguments free from defaults', () => {
    const args = { objectId: randomUUID(), pages: [5, 2, 2] };
    expect(WorkspaceDocumentReadArgsSchema.parse(args)).toEqual(args);
    expect(
      WorkspaceDocumentReadArgsSchema.parse({ objectId: args.objectId }),
    ).toEqual({ objectId: args.objectId });
    const { payload, result } = fixture();
    expect(payload.arguments.options.pages).toEqual([5, 2, 2]);
    expect(localPdfResultMatchesPayload(result, payload)).toBe(true);
  });
  it.each([
    'source',
    'pages',
    'origin',
    'pins',
    'version',
    'structure',
  ] as const)('rejects %s substituted by a client', (kind) => {
    const { payload, result } = fixture();
    if (kind === 'source') result.source.objectId = randomUUID();
    if (kind === 'pages') result.document!.requestedPages = [1, 2];
    if (kind === 'origin')
      result.origin.argumentsDigest = `sha256:${'c'.repeat(64)}`;
    if (kind === 'pins')
      result.pins.policyChecksum = `sha256:${'d'.repeat(64)}`;
    if (kind === 'version') result.source.artifactVersion = 3;
    if (kind === 'structure')
      payload.arguments.options.includeStructure = false;
    expect(localPdfResultMatchesPayload(result, payload)).toBe(false);
  });
  it('rejects extra authority and arbitrary execution inputs', () => {
    const { payload } = fixture();
    expect(
      RuntimeLocalPdfPayloadSchema.safeParse({
        ...payload,
        arguments: { ...payload.arguments, path: '/Users/owner' },
      }).success,
    ).toBe(false);
    for (const key of ['script', 'password', 'url', 'module', 'outputPath'])
      expect(
        RuntimeLocalPdfPayloadSchema.safeParse({
          ...payload,
          arguments: { ...payload.arguments, [key]: 'untrusted' },
        }).success,
      ).toBe(false);
  });
  it('does not advertise output before the parser has physically stopped', () => {
    const { result } = fixture();
    expect(
      RuntimeLocalPdfResultSchema.safeParse({
        ...result,
        process: { ...result.process, stopped: false },
      }).success,
    ).toBe(false);
    expect(
      RuntimeLocalPdfResultSchema.safeParse({
        ...result,
        error: { code: 'FAILED', message: 'incomplete' },
      }).success,
    ).toBe(false);
  });
  it('budgets the complete duplicated Unicode JSON, including table cells', () => {
    const { result } = fixture(),
      doc = result.document!;
    expect(
      PdfReadDocumentSchema.safeParse({
        ...doc,
        text: '界'.repeat(70_000),
        units: [{ label: '第2页', pageNumber: 2, text: '界'.repeat(70_000) }],
      }).success,
    ).toBe(false);
    expect(
      PdfReadDocumentSchema.safeParse({
        ...doc,
        tables: [
          {
            pageNumber: 2,
            tableNumber: 1,
            rows: [{ rowNumber: 1, cells: ['界'.repeat(140_000)] }],
          },
        ],
      }).success,
    ).toBe(false);
  });
  it.each(['units', 'tables'] as const)(
    'applies the original character budget to %s as well as text',
    (part) => {
      const { payload, result } = fixture();
      payload.arguments.options.maxCharacters = 1_000;
      result.document!.text = '';
      if (part === 'units')
        result.document!.units[0]!.text = '界'.repeat(2_000);
      else result.document!.tables![0]!.rows[0]!.cells = ['界'.repeat(2_000)];
      expect(RuntimeLocalPdfResultSchema.safeParse(result).success).toBe(true);
      expect(localPdfResultMatchesPayload(result, payload)).toBe(false);
    },
  );
  it('requires known exact release pins, independent of an available claim', () => {
    const profile = RuntimeLocalPdfProfileSchema.parse({
      contractVersion: 1,
      profileVersion: 1,
      backend: 'native-seatbelt-v1',
      platform: 'macos-x64',
      pins: release.pins,
      available: true,
      readOnly: true,
      ocr: false,
      stopConfirmed: true,
      isolation: {
        network: 'none',
        hostFileAccess: 'none',
        childExecution: 'none',
        memoryEnforcement: 'watchdog',
        resourceBudgetBytes: 512 * 1024 * 1024,
        watchdogThresholdBytes: 512 * 1024 * 1024,
        timeoutMs: 30_000,
        deniedHostRead: true,
        deniedHostWrite: true,
        deniedNetwork: true,
        deniedChildExecution: true,
      },
      limits: {
        inputBytes: 20 * 1024 * 1024,
        resultBytes: 400_000,
        maximumPages: 10,
        maximumCharacters: 300_000,
      },
    });
    expect(localPdfProfileMatchesRelease(profile, release)).toBe(true);
    expect(
      localPdfProfileMatchesRelease(
        {
          ...profile,
          pins: {
            ...profile.pins,
            resourceManifestChecksum: `sha256:${'0'.repeat(64)}`,
          },
        },
        release,
      ),
    ).toBe(false);
    expect(
      RuntimeLocalPdfProfileSchema.safeParse({
        ...profile,
        isolation: { ...profile.isolation, deniedNetwork: false },
      }).success,
    ).toBe(false);
    expect(pdfReadReleaseForPlatform('macos-arm64')).toBeNull();
    expect(pdfReadReleaseForPlatform('windows-x64')).toBeNull();
  });
});
