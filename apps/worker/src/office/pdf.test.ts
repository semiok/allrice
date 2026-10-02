import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { officeMediaTypes } from '@allrice/contracts';
import type { RiceToolExecutionInput } from '../tool-broker/types.js';

const { select, getFile, storageGet, preview } = vi.hoisted(() => ({
  select: vi.fn(),
  getFile: vi.fn(),
  storageGet: vi.fn(),
  preview: vi.fn(),
}));
vi.mock('@allrice/database', () => ({
  selectOfficePdfExecution: select,
  getToolBrokerFile: getFile,
}));
vi.mock('@allrice/storage', () => ({
  LocalStorageAdapter: class {
    get = storageGet;
  },
}));
vi.mock('@allrice/office-runtime/preview', () => ({
  previewOfficePdf: preview,
}));
import { generateOfficePdfExport } from './pdf.js';

const sourceBytes = Buffer.from('authorized immutable original Office bytes');
const pdfBytes = Uint8Array.from(
  Buffer.from('%PDF-1.7\noriginal DSH PDF bytes\n%%EOF'),
);
const hash = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const result = () => ({
  pdf: pdfBytes,
  missingFonts: ['Noto Sans CJK SC'],
  cacheKey: 'provider-owned-cache-key',
  generation: 'provider-generation',
});

function setup(format: 'docx' | 'xlsx' | 'pptx' = 'docx') {
  const organizationId = randomUUID(),
    actor = randomUUID(),
    objectId = randomUUID();
  const officePdf = { objectId, checksum: hash(sourceBytes) };
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
    call: {
      id: randomUUID(),
      name: 'workspace.export.create',
      arguments: { format: 'pdf', officePdf, fileName: '合成报告.pdf' },
    },
    capabilities: ['storage:read', 'storage:write'],
    storageRoot: 'unused mocked storage',
    sessionId: randomUUID(),
    managedBrowserJobAttempt: 2,
    managedBrowserJobLeaseToken: randomUUID(),
  };
  const file = {
    object: {
      id: objectId,
      checksum: officePdf.checksum,
      mediaType: officeMediaTypes[format] as string,
      sizeBytes: sourceBytes.length,
    },
    fileName: `原文件.${format}`,
  };
  const selection = {
    choice: {
      location: 'cloud',
      status: 'execute',
      reason: 'local_unsupported',
    },
    selectionReason: 'local_unsupported',
    selectionId: randomUUID(),
    deadlineAt: new Date(Date.now() + 120000).toISOString(),
    source: { source: officePdf, derivation: true },
  };
  select.mockResolvedValue(selection);
  getFile.mockResolvedValue(file);
  storageGet.mockImplementation(async () => new Blob([sourceBytes]).stream());
  preview.mockImplementation(async (args) => {
    const bytes = await args.read(new AbortController().signal, args.sizeBytes);
    expect(bytes).toEqual(sourceBytes);
    return result();
  });
  return { input, officePdf, file, selection };
}

describe('original Office bytes through the existing DSH PDF provider', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each(['docx', 'xlsx', 'pptx'] as const)(
    'passes authorized %s bytes without Python or a replacement converter',
    async (format) => {
      const { input, officePdf } = setup(format);
      const generated = await generateOfficePdfExport(input, officePdf, 'auto');
      expect(select).toHaveBeenCalledWith({
        context: input.context,
        callId: input.call.id,
        arguments: input.call.arguments,
        officePdf,
        jobAttempt: 2,
        jobLeaseToken: input.managedBrowserJobLeaseToken,
        location: 'auto',
      });
      expect(select.mock.calls[0]![0].arguments).toBe(input.call.arguments);
      expect(preview).toHaveBeenCalledWith(
        expect.objectContaining({
          objectId: officePdf.objectId,
          checksum: officePdf.checksum,
          sizeBytes: sourceBytes.length,
          format,
          signal: expect.any(AbortSignal),
          read: expect.any(Function),
        }),
      );
      expect(storageGet).toHaveBeenCalledOnce();
      expect(generated.bytes).toEqual(Buffer.from(pdfBytes));
      expect(generated.sourceFile).toEqual(officePdf);
      expect(generated).not.toHaveProperty('parentObjectId');
      expect(generated).not.toHaveProperty('quality');
      expect(generated.nativeConversion).toMatchObject({
        status: 'converted',
        backend: 'platform-dsh-provider',
        executionLocation: 'cloud',
        executionReason: 'local_unsupported',
        sourceFormat: format,
        missingFonts: ['Noto Sans CJK SC'],
        cache: {
          key: 'provider-owned-cache-key',
          generation: 'provider-generation',
        },
      });
      expect(generated.warnings[0]).toContain('Noto Sans CJK SC');
    },
  );

  it.each(['unavailable', 'wait', 'reconcile'])(
    'does zero source reads and conversions for %s admission',
    async (status) => {
      const { input, officePdf, selection } = setup();
      select.mockResolvedValue({
        ...selection,
        choice: { location: 'none', status, reason: 'local_inputs_required' },
        selectionReason: 'local_inputs_required',
        source: null,
      });
      await expect(
        generateOfficePdfExport(input, officePdf, 'local'),
      ).rejects.toMatchObject({ code: 'OFFICE_PDF_EXECUTION_UNAVAILABLE' });
      expect(getFile).not.toHaveBeenCalled();
      expect(storageGet).not.toHaveBeenCalled();
      expect(preview).not.toHaveBeenCalled();
    },
  );

  it('rejects missing capability or lease before source access', async () => {
    const { input, officePdf } = setup();
    await expect(
      generateOfficePdfExport(
        { ...input, capabilities: ['storage:write'] },
        officePdf,
      ),
    ).rejects.toMatchObject({ code: 'TOOL_CAPABILITY_DENIED' });
    await expect(
      generateOfficePdfExport(
        { ...input, managedBrowserJobLeaseToken: undefined },
        officePdf,
      ),
    ).rejects.toMatchObject({ code: 'OFFICE_PDF_LEASE_UNAVAILABLE' });
    expect(select).not.toHaveBeenCalled();
    expect(getFile).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  it('does zero selection/read/conversion when the caller is already canceled', async () => {
    const { input, officePdf } = setup();
    const control = new AbortController(),
      reason = new Error('own run canceled');
    control.abort(reason);
    await expect(
      generateOfficePdfExport({ ...input, signal: control.signal }, officePdf),
    ).rejects.toBe(reason);
    expect(select).not.toHaveBeenCalled();
    expect(getFile).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  it('honors the original job deadline before opening storage', async () => {
    const { input, officePdf, selection } = setup();
    select.mockResolvedValue({
      ...selection,
      deadlineAt: new Date(Date.now() - 1).toISOString(),
    });
    await expect(
      generateOfficePdfExport(input, officePdf),
    ).rejects.toMatchObject({ code: 'OFFICE_PDF_LEASE_UNAVAILABLE' });
    expect(getFile).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  it.each(['checksum', 'id', 'mime', 'size'])(
    'rejects changed or disallowed %s metadata before conversion',
    async (field) => {
      const { input, officePdf, file } = setup();
      if (field === 'checksum')
        file.object.checksum = hash(Buffer.from('changed'));
      if (field === 'id') file.object.id = randomUUID();
      if (field === 'mime') file.object.mediaType = 'application/pdf';
      if (field === 'size') file.object.sizeBytes = 20 * 1024 * 1024 + 1;
      await expect(
        generateOfficePdfExport(input, officePdf),
      ).rejects.toMatchObject({
        code:
          field === 'mime'
            ? 'TOOL_INPUT_INVALID'
            : field === 'size'
              ? 'TOOL_FILE_TOO_LARGE'
              : 'TOOL_SOURCE_CHANGED',
      });
      expect(storageGet).not.toHaveBeenCalled();
      expect(preview).not.toHaveBeenCalled();
    },
  );

  it.each(['different hash', 'short bytes', 'extra bytes'])(
    'checks the actual immutable input: %s',
    async (change) => {
      const { input, officePdf } = setup();
      const changed =
        change === 'different hash'
          ? Buffer.alloc(sourceBytes.length, 65)
          : change === 'short bytes'
            ? sourceBytes.subarray(1)
            : Buffer.concat([sourceBytes, Buffer.from('extra')]);
      storageGet.mockResolvedValue(new Blob([changed]).stream());
      await expect(
        generateOfficePdfExport(input, officePdf),
      ).rejects.toMatchObject({ code: 'TOOL_SOURCE_CHANGED' });
    },
  );

  it('enforces the provider read reservation before storage access', async () => {
    const { input, officePdf } = setup();
    preview.mockImplementation(async (args) => {
      await args.read(new AbortController().signal, args.sizeBytes - 1);
      return result();
    });
    await expect(
      generateOfficePdfExport(input, officePdf),
    ).rejects.toMatchObject({ code: 'TOOL_FILE_TOO_LARGE' });
    expect(storageGet).not.toHaveBeenCalled();
  });

  it('validates original bytes even when the provider returns a cached PDF without reading', async () => {
    const { input, officePdf } = setup();
    preview.mockResolvedValue(result());
    expect((await generateOfficePdfExport(input, officePdf)).bytes).toEqual(
      Buffer.from(pdfBytes),
    );
    expect(storageGet).toHaveBeenCalledOnce();
    storageGet.mockResolvedValue(
      new Blob([Buffer.alloc(sourceBytes.length, 65)]).stream(),
    );
    await expect(
      generateOfficePdfExport(input, officePdf),
    ).rejects.toMatchObject({ code: 'TOOL_SOURCE_CHANGED' });
    expect(preview).toHaveBeenCalledTimes(2);
  });

  it.each(['caller', 'provider'])(
    'cancels a stalled source read through the %s signal',
    async (origin) => {
      const { input, officePdf } = setup();
      const caller = new AbortController(),
        provider = new AbortController(),
        reason = new Error('cancel stalled bytes');
      const cancel = vi.fn();
      storageGet.mockResolvedValue(
        new ReadableStream({ pull: () => new Promise(() => {}), cancel }),
      );
      preview.mockImplementation(async (args) => {
        await args.read(provider.signal, args.sizeBytes);
        return result();
      });
      const pending = generateOfficePdfExport(
        { ...input, signal: caller.signal },
        officePdf,
      );
      await vi.waitFor(() => expect(storageGet).toHaveBeenCalledOnce());
      (origin === 'caller' ? caller : provider).abort(reason);
      await expect(pending).rejects.toBe(reason);
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    },
  );

  it('cannot return publishable bytes after cancellation during conversion', async () => {
    const { input, officePdf } = setup();
    const control = new AbortController(),
      reason = new Error('conversion canceled');
    preview.mockImplementation(async (args) => {
      await args.read(new AbortController().signal, args.sizeBytes);
      control.abort(reason);
      return result();
    });
    await expect(
      generateOfficePdfExport({ ...input, signal: control.signal }, officePdf),
    ).rejects.toBe(reason);
  });

  it('rejects an oversized PDF and preserves provider failures without publishing', async () => {
    const { input, officePdf } = setup();
    preview.mockResolvedValue({ ...result(), pdf: new Uint8Array(8_000_001) });
    await expect(
      generateOfficePdfExport(input, officePdf),
    ).rejects.toMatchObject({ code: 'TOOL_FILE_TOO_LARGE' });
    const failed = new Error('provider failed after cleanup');
    preview.mockRejectedValue(failed);
    await expect(generateOfficePdfExport(input, officePdf)).rejects.toBe(
      failed,
    );
  });
});
