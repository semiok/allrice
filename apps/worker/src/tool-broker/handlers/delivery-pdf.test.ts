import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { officeMediaTypes } from '@allrice/contracts';
import type * as Database from '@allrice/database';
import { ArtifactPublicationParentError } from '@allrice/database';
import type * as OfficeExport from '../../office/export.js';
import type * as Deliverable from '../../deliverable-generator.js';
import type { RiceToolExecutionInput } from '../types.js';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  getFile: vi.fn(),
  get: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
  preview: vi.fn(),
  publish: vi.fn(),
  register: vi.fn(),
  object: vi.fn(),
  workbench: vi.fn(),
  content: vi.fn(),
  legacy: vi.fn(),
  python: vi.fn(),
  quality: vi.fn(),
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  selectOfficePdfExecution: mocks.select,
  getToolBrokerFile: mocks.getFile,
  publishWorkbenchArtifact: mocks.publish,
  registerToolBrokerExport: mocks.register,
  createToolBrokerExportObject: mocks.object,
  workbenchEnabled: mocks.workbench,
}));
vi.mock('@allrice/storage', () => ({
  LocalStorageAdapter: class {
    get = mocks.get;
    put = mocks.put;
    delete = mocks.remove;
  },
}));
vi.mock('@allrice/office-runtime/preview', () => ({
  previewOfficePdf: mocks.preview,
}));
vi.mock('../../deliverable-generator.js', () => ({
  generateDeliverable: mocks.content,
}));
vi.mock('../../office/native.js', () => ({
  generateNativeOfficeExport: mocks.python,
}));
vi.mock('../../office/quality.js', () => ({
  checkOfficeExport: mocks.quality,
}));
vi.mock('../../office/export.js', async (original) => ({
  ...(await original<typeof OfficeExport>()),
  generateOfficeExport: mocks.legacy,
}));
import { createWorkspaceExport } from './delivery.js';

const original = Buffer.from('authorized original office bytes');
const rawPdf = Buffer.from('%PDF-1.7\noriginal existing provider bytes\n%%EOF');
const hash = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function setup() {
  const organizationId = randomUUID(),
    actor = randomUUID(),
    officePdf = { objectId: randomUUID(), checksum: hash(original) };
  const args: Record<string, unknown> = {
    format: 'pdf',
    officePdf,
    location: 'auto',
    fileName: '中文报告',
    changeSummary: '保留原文件内容并转换PDF',
  };
  const input: RiceToolExecutionInput = {
    context: {
      executionId: randomUUID(),
      runId: randomUUID(),
      jobId: randomUUID(),
      worker: { type: 'worker', id: randomUUID() },
      delegatedBy: { type: 'user', id: actor },
      organizationId,
      workspaceId: randomUUID(),
      startedAt: new Date().toISOString(),
      policySnapshot: {
        id: randomUUID(),
        organizationId,
        subjectId: actor,
        version: 1,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        memberships: [],
        grants: [],
      },
    },
    capabilities: ['storage:read', 'storage:write'],
    storageRoot: 'mocked-only-storage',
    sessionId: randomUUID(),
    managedBrowserJobAttempt: 1,
    managedBrowserJobLeaseToken: randomUUID(),
    call: {
      id: randomUUID(),
      name: 'workspace.export.create',
      arguments: args,
    },
  };
  const output = {
    id: randomUUID(),
    checksum: hash(rawPdf),
    mediaType: 'application/pdf',
    sizeBytes: rawPdf.length,
  };
  mocks.select.mockResolvedValue({
    choice: {
      location: 'cloud',
      status: 'execute',
      reason: 'local_unsupported',
    },
    selectionReason: 'local_unsupported',
    selectionId: randomUUID(),
    deadlineAt: new Date(Date.now() + 120000).toISOString(),
    source: { source: officePdf, derivation: true },
  });
  mocks.getFile.mockResolvedValue({
    object: {
      id: officePdf.objectId,
      checksum: officePdf.checksum,
      mediaType: officeMediaTypes.docx,
      sizeBytes: original.length,
    },
  });
  mocks.get.mockImplementation(async () => new Blob([original]).stream());
  mocks.preview.mockImplementation(async (input) => {
    await input.read(new AbortController().signal, input.sizeBytes);
    return {
      pdf: Uint8Array.from(rawPdf),
      missingFonts: ['Noto Sans CJK SC'],
      cacheKey: 'cache-is-not-artifact',
      generation: 'provider-generation',
    };
  });
  mocks.workbench.mockReturnValue(true);
  mocks.publish.mockResolvedValue({
    id: randomUUID(),
    object: output,
    version: {
      seriesId: randomUUID(),
      version: 3,
      parentObjectId: null,
      changeSummary: args.changeSummary,
    },
  });
  mocks.object.mockReturnValue(output);
  mocks.register.mockResolvedValue({
    seriesId: randomUUID(),
    version: 3,
    parentObjectId: null,
  });
  mocks.quality.mockImplementation(async (bytes, format) => ({
    bytes,
    quality: {
      status: 'checked',
      format,
      pageCount: 1,
      formulaCount: 0,
      formulaErrorCount: 0,
      layout: 'rendered_not_visually_reviewed',
    },
    warnings: [],
  }));
  return { input, args, officePdf, output };
}

describe('Office-to-PDF in the existing export publisher', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  it.each(['checked', 'unavailable'] as const)(
    'passes only the real %s Office checker receipt to immutable publication',
    async (status) => {
      const { input, args } = setup();
      delete args.officePdf;
      delete args.location;
      args.format = 'docx';
      args.office = {};
      args.officeReceipt = { quality: { status: 'checked', pageCount: 9999 } };
      mocks.legacy.mockResolvedValue({
        bytes: original,
        mediaType: officeMediaTypes.docx,
        extension: '.docx',
      });
      const quality =
        status === 'checked'
          ? {
              status,
              format: 'docx',
              pageCount: 2,
              formulaCount: 0,
              formulaErrorCount: 0,
              layout: 'rendered_not_visually_reviewed',
            }
          : { status, reason: 'Checker not available' };
      mocks.quality.mockResolvedValue({
        bytes: original,
        quality,
        warnings: ['Business review remains required'],
      });
      await createWorkspaceExport({ input, arguments: args });
      expect(mocks.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          bytes: original,
          officeReceipt: {
            quality,
            warnings: ['Business review remains required'],
          },
        }),
        expect.anything(),
      );
      expect(
        mocks.publish.mock.calls[0]![0].officeReceipt.quality.pageCount,
      ).not.toBe(9999);
    },
  );

  it('publishes unchanged DSH PDF bytes and forwards source, fonts and actual service location', async () => {
    const { input, args, officePdf, output } = setup();
    const result = await createWorkspaceExport({ input, arguments: args });
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        context: input.context,
        sessionId: input.sessionId,
        callId: input.call.id,
        fileName: '中文报告.pdf',
        format: 'pdf',
        mediaType: 'application/pdf',
        bytes: rawPdf,
        sourceFile: officePdf,
        changeSummary: args.changeSummary,
      }),
      expect.anything(),
    );
    expect(mocks.publish.mock.calls[0]![0]).not.toHaveProperty(
      'parentObjectId',
    );
    expect(mocks.publish.mock.calls[0]![0].trustedOfficePdfLease).toEqual({
      jobAttempt: input.managedBrowserJobAttempt,
      jobLeaseToken: input.managedBrowserJobLeaseToken,
    });
    expect(mocks.quality).not.toHaveBeenCalled();
    const receipt = JSON.parse(result.modelContent);
    expect(receipt.objectId).toBe(output.id);
    expect(receipt.artifactId).not.toBe('cache-is-not-artifact');
    expect(receipt.digest).toBe(hash(rawPdf));
    expect(receipt.sourceFile).toEqual(officePdf);
    expect(receipt.nativeConversion).toMatchObject({
      status: 'converted',
      backend: 'platform-dsh-provider',
      executionLocation: 'cloud',
      executionReason: 'local_unsupported',
      missingFonts: ['Noto Sans CJK SC'],
      cache: {
        key: 'cache-is-not-artifact',
        generation: 'provider-generation',
      },
    });
    expect(receipt).not.toHaveProperty('quality');
    expect(receipt.downloadUrl).toContain(output.id);
    expect(receipt.version).toBe(3);
  });

  it('cannot bypass exact Run/call/lease authority via legacy registration', async () => {
    const { input, args } = setup();
    mocks.workbench.mockReturnValue(false);
    await expect(
      createWorkspaceExport({ input, arguments: args }),
    ).rejects.toMatchObject({ code: 'OFFICE_PDF_PUBLICATION_UNAVAILABLE' });
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it.each([
    { content: 'duplicate' },
    { python: {} },
    { office: {} },
    { format: 'docx' },
    { artifactKind: 'changeset' },
  ])(
    'rejects conflicting PDF mode before source access: %j',
    async (invalid) => {
      const { input, args } = setup();
      const changed = { ...args, ...invalid };
      await expect(
        createWorkspaceExport({
          input: { ...input, call: { ...input.call, arguments: changed } },
          arguments: changed,
        }),
      ).rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' });
      expect(mocks.select).not.toHaveBeenCalled();
      expect(mocks.preview).not.toHaveBeenCalled();
      expect(mocks.publish).not.toHaveBeenCalled();
    },
  );

  it('keeps content PDF generation and legacy Office quality on their existing paths', async () => {
    const { input } = setup();
    mocks.content.mockResolvedValue({
      bytes: rawPdf,
      mediaType: 'application/pdf',
      extension: '.pdf',
    });
    const content = {
      fileName: 'legacy-content',
      format: 'pdf',
      content: '原文字路径',
    };
    await createWorkspaceExport({
      input: { ...input, call: { ...input.call, arguments: content } },
      arguments: content,
    });
    expect(mocks.content).toHaveBeenCalledWith({
      format: 'pdf',
      content: '原文字路径',
    });
    expect(mocks.publish.mock.calls[0]![0]).not.toHaveProperty(
      'trustedOfficePdfLease',
    );
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.quality).not.toHaveBeenCalled();
    const office = {
      fileName: 'legacy-office',
      format: 'docx',
      office: { kind: 'docx', title: '旧结构路径', blocks: [] },
    };
    mocks.legacy.mockResolvedValue({
      bytes: original,
      mediaType: officeMediaTypes.docx,
      extension: '.docx',
      sourceFile: undefined,
      warnings: [],
      changes: undefined,
    });
    await createWorkspaceExport({
      input: { ...input, call: { ...input.call, arguments: office } },
      arguments: office,
    });
    expect(mocks.legacy).toHaveBeenCalledWith(
      expect.anything(),
      'docx',
      office.office,
    );
    expect(mocks.quality).toHaveBeenCalledWith(original, 'docx', {
      cloudQualityAllowed: true,
    });
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it('rejects local-only admission without reading or converting and cannot publish', async () => {
    const { input, args } = setup();
    mocks.select.mockResolvedValue({
      choice: {
        status: 'unavailable',
        location: 'none',
        reason: 'local_inputs_required',
      },
      selectionReason: 'local_inputs_required',
      source: null,
      deadlineAt: new Date(Date.now() + 60000).toISOString(),
    });
    await expect(
      createWorkspaceExport({ input, arguments: args }),
    ).rejects.toMatchObject({ code: 'OFFICE_PDF_EXECUTION_UNAVAILABLE' });
    expect(mocks.getFile).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it.each(['empty', 'oversized', 'failed'])(
    'cannot publish a %s conversion',
    async (kind) => {
      const { input, args } = setup();
      if (kind === 'failed')
        mocks.preview.mockRejectedValue(new Error('provider failure'));
      else
        mocks.preview.mockResolvedValue({
          pdf: new Uint8Array(kind === 'empty' ? 0 : 8_000_001),
          missingFonts: [],
          cacheKey: 'irrelevant',
          generation: 'irrelevant',
        });
      await expect(
        createWorkspaceExport({ input, arguments: args }),
      ).rejects.toThrow();
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(mocks.put).not.toHaveBeenCalled();
      expect(mocks.register).not.toHaveBeenCalled();
    },
  );

  it('checks caller cancellation before access and again at publication', async () => {
    const { input, args } = setup();
    const control = new AbortController(),
      reason = new Error('own run canceled');
    control.abort(reason);
    await expect(
      createWorkspaceExport({
        input: { ...input, signal: control.signal },
        arguments: args,
      }),
    ).rejects.toBe(reason);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
    const later = new AbortController();
    mocks.workbench.mockReturnValueOnce(true).mockImplementation(() => {
      later.abort(reason);
      return true;
    });
    await expect(
      createWorkspaceExport({
        input: { ...input, signal: later.signal },
        arguments: args,
      }),
    ).rejects.toBe(reason);
    expect(mocks.preview).toHaveBeenCalledOnce();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});

describe('Plain content through the existing export publisher', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each([
    ['text', 'foo.csv', 'foo.csv', 'text/csv'],
    ['text', '中文.CSV', '中文.CSV', 'text/csv'],
    ['text', 'foo', 'foo.txt', 'text/plain'],
    ['text', 'foo.csv.txt', 'foo.csv.txt', 'text/plain'],
    ['text', 'foo.csv.exe', 'foo.csv.exe.txt', 'text/plain'],
    ['text', 'report.html', 'report.html.txt', 'text/plain'],
    ['text', 'report.svg', 'report.svg.txt', 'text/plain'],
    ['text', 'csv', 'csv.txt', 'text/plain'],
    ['text', 'folder/foo.csv', 'folder-foo.csv', 'text/csv'],
    ['text', '  foo.csv  ', 'foo.csv', 'text/csv'],
    ['text', 'a'.repeat(121) + '.csv', 'a'.repeat(120) + '.csv', 'text/csv'],
    ['html', 'foo.csv', 'foo.csv.html', 'text/html'],
    ['markdown', 'foo.csv', 'foo.csv.md', 'text/markdown'],
  ])(
    'publishes %s filename %s with its permitted suffix and forwards the exact parent',
    async (format, requestedName, fileName, mediaType) => {
      const { input, output } = setup(),
        parentObjectId = randomUUID(),
        seriesId = randomUUID();
      const content = '\uFEFF编号,备注\r\n00123,"保留,逗号"\r\n';
      const generator = await vi.importActual<typeof Deliverable>(
        '../../deliverable-generator.js',
      );
      mocks.content.mockImplementation(generator.generateDeliverable);
      mocks.publish.mockImplementation(async (publication) => ({
        id: randomUUID(),
        object: {
          ...output,
          mediaType: publication.mediaType,
          sizeBytes: publication.bytes.length,
          checksum: hash(publication.bytes),
        },
        version: {
          seriesId,
          version: 4,
          parentObjectId,
          changeSummary: '修订内容',
        },
      }));
      const result = await createWorkspaceExport({
        input,
        arguments: {
          format,
          content,
          fileName: requestedName,
          parentObjectId,
          changeSummary: '修订内容',
        },
      });
      expect(mocks.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          format,
          fileName,
          mediaType,
          bytes: Buffer.from(content),
          parentObjectId,
          changeSummary: '修订内容',
        }),
        expect.anything(),
      );
      expect(mocks.content).toHaveBeenCalledWith({
        format,
        content,
        ...(format === 'text' ? { fileName: requestedName.trim() } : {}),
      });
      expect(JSON.parse(result.modelContent)).toMatchObject({
        fileName,
        mediaType,
        seriesId,
        version: 4,
        parentObjectId,
        downloadUrl: `/api/v1/files/${output.id}/download?name=${encodeURIComponent(fileName)}`,
      });
      expect(mocks.put).not.toHaveBeenCalled();
      expect(mocks.register).not.toHaveBeenCalled();
      expect(mocks.quality).not.toHaveBeenCalled();
    },
  );

  it('keeps CSV bytes and format=text on the legacy version path', async () => {
    const { input, output } = setup(),
      parentObjectId = randomUUID();
    const content = '\uFEFF编号,金额\r\n00123,-200.00\r\n';
    const generator = await vi.importActual<typeof Deliverable>(
      '../../deliverable-generator.js',
    );
    mocks.content.mockImplementation(generator.generateDeliverable);
    mocks.workbench.mockReturnValue(false);
    mocks.object.mockImplementation(({ mediaType, sizeBytes, checksum }) => ({
      ...output,
      mediaType,
      sizeBytes,
      checksum,
    }));
    mocks.register.mockResolvedValue({
      seriesId: randomUUID(),
      version: 2,
      parentObjectId,
    });
    const result = await createWorkspaceExport({
      input,
      arguments: {
        format: 'text',
        fileName: 'ledger.csv',
        content,
        parentObjectId,
      },
    });
    expect(mocks.object).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaType: 'text/csv',
        sizeBytes: Buffer.byteLength(content),
        checksum: hash(Buffer.from(content)),
      }),
    );
    const stored = mocks.put.mock.calls[0]![0];
    const actualBytes = Buffer.from(
      await new Response(mocks.put.mock.calls[0]![1]).arrayBuffer(),
    );
    expect(actualBytes).toEqual(Buffer.from(content));
    expect(stored.mediaType).toBe('text/csv');
    expect(stored.checksum).toBe(hash(actualBytes));
    expect(mocks.register).toHaveBeenCalledWith(
      expect.objectContaining({
        format: 'text',
        fileName: 'ledger.csv',
        parentObjectId,
        object: stored,
      }),
    );
    expect(JSON.parse(result.modelContent)).toMatchObject({
      fileName: 'ledger.csv',
      mediaType: 'text/csv',
      version: 2,
      parentObjectId,
    });
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('does not bypass parent compatibility or fall back when a CSV parent is rejected', async () => {
    const { input } = setup(),
      parentObjectId = randomUUID();
    const generator = await vi.importActual<typeof Deliverable>(
      '../../deliverable-generator.js',
    );
    mocks.content.mockImplementation(generator.generateDeliverable);
    mocks.publish.mockRejectedValue(
      new ArtifactPublicationParentError(
        input.context.runId,
        input.call.id,
        'version_changed',
      ),
    );
    await expect(
      createWorkspaceExport({
        input,
        arguments: {
          format: 'text',
          fileName: 'same.csv',
          content: 'a,b\n1,2\n',
          parentObjectId,
        },
      }),
    ).rejects.toMatchObject({
      code: 'TOOL_PUBLICATION_PARENT_INVALID',
      retryable: false,
    });
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        format: 'text',
        fileName: 'same.csv',
        parentObjectId,
      }),
      expect.anything(),
    );
    expect(mocks.object).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it.each(['text', 'markdown', 'html'])(
    'preserves exact %s content bytes, including indentation and final newlines',
    async (format) => {
      const { input } = setup();
      const content = '\n  indented first line\r\n\tlast line  \n\n';
      const generator = await vi.importActual<typeof Deliverable>(
        '../../deliverable-generator.js',
      );
      mocks.content.mockImplementation(generator.generateDeliverable);
      await createWorkspaceExport({
        input,
        arguments: { format, content, fileName: 'whitespace' },
      });
      expect(mocks.publish).toHaveBeenCalledWith(
        expect.objectContaining({ format, bytes: Buffer.from(content) }),
        expect.anything(),
      );
    },
  );

  it.each([undefined, null, 42, '', ' \r\n\t '])(
    'rejects empty or non-string content before generation (%s)',
    async (content) => {
      const { input } = setup();
      await expect(
        createWorkspaceExport({
          input,
          arguments: { format: 'text', content },
        }),
      ).rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' });
      expect(mocks.content).not.toHaveBeenCalled();
      expect(mocks.publish).not.toHaveBeenCalled();
    },
  );

  it('counts preserved whitespace toward the existing content size limit', async () => {
    const { input } = setup();
    const generator = await vi.importActual<typeof Deliverable>(
      '../../deliverable-generator.js',
    );
    mocks.content.mockImplementation(generator.generateDeliverable);
    const content = 'x' + ' '.repeat(199_999);
    await createWorkspaceExport({
      input,
      arguments: { format: 'text', content, fileName: 'limit' },
    });
    expect(mocks.publish.mock.calls[0]![0].bytes.byteLength).toBe(200_000);
    mocks.content.mockClear();
    mocks.publish.mockClear();
    await expect(
      createWorkspaceExport({
        input,
        arguments: {
          format: 'text',
          content: content + '\n',
          fileName: 'limit',
        },
      }),
    ).rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' });
    expect(mocks.content).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
