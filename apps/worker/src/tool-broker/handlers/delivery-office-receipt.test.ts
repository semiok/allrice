import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { officeMediaTypes } from '@allrice/contracts';
import { isConfirmedToolFailure } from '../../errors.js';

// Actual handler and projection; all execution, storage and DB ports are inert.
const ports = vi.hoisted(() => ({
  publish: vi.fn(),
  register: vi.fn(),
  object: vi.fn(),
  workbench: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
  content: vi.fn(),
  office: vi.fn(),
  native: vi.fn(),
  quality: vi.fn(),
}));
vi.mock('@allrice/database', async (original) => {
  const { ArtifactPublicationRollbackError, ArtifactPublicationParentError } =
    await original<typeof Database>();
  return {
    ArtifactPublicationRollbackError,
    ArtifactPublicationParentError,
    publishWorkbenchArtifact: ports.publish,
    publishWorkbenchChangesetProposal: ports.publish,
    registerToolBrokerExport: ports.register,
    createToolBrokerExportObject: ports.object,
    workbenchEnabled: ports.workbench,
  };
});
vi.mock('@allrice/storage', () => ({
  LocalStorageAdapter: class {
    put = ports.put;
    delete = ports.remove;
  },
}));
vi.mock('../../deliverable-generator.js', () => ({
  generateDeliverable: ports.content,
}));
vi.mock('../../office/export.js', () => ({
  generateOfficeExport: ports.office,
}));
vi.mock('../../office/native.js', () => ({
  generateNativeOfficeExport: ports.native,
}));
vi.mock('../../office/pdf.js', () => ({
  generateOfficePdfExport: vi.fn(() => {
    throw Error('PDF execution is outside these tests');
  }),
}));
vi.mock('../../office/quality.js', () => ({
  checkOfficeExport: ports.quality,
}));
import { createWorkspaceExport } from './delivery.js';

const hash = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const source = Buffer.from('generator bytes'),
  final = Buffer.from('post-cache-patch bytes');
function setup(
  mode: 'native' | 'office' | 'content' = 'native',
  workbench = true,
) {
  const args: Record<string, unknown> = {
    format: 'xlsx',
    fileName: 'reconciliation.xlsx',
  };
  if (mode === 'native')
    args.python = { script: 'synthetic fixture', inputs: [] };
  if (mode === 'office') args.office = { kind: 'synthetic fixture' };
  if (mode === 'content') args.content = 'synthetic fixture';
  const input = {
    context: { runId: randomUUID(), workspaceId: randomUUID() },
    sessionId: randomUUID(),
    storageRoot: 'never-opened-unit-test-storage',
    capabilities: [],
    call: {
      id: randomUUID(),
      name: 'workspace.export.create',
      arguments: args,
    },
  } as unknown as Parameters<typeof createWorkspaceExport>[0]['input'];
  const generated = {
    bytes: source,
    mediaType: officeMediaTypes.xlsx,
    extension: '.xlsx',
    sourceFile: undefined,
    warnings: [],
    changes: undefined,
  };
  ports.content.mockResolvedValue(generated);
  ports.office.mockResolvedValue(generated);
  ports.native.mockResolvedValue(generated);
  const checked = {
    bytes: final,
    quality: {
      status: 'unavailable' as const,
      reason: 'Original unavailable reason',
    },
    warnings: ['Original unavailable reason'],
    diagnostic: { stage: 'renderer' as const, code: 'renderer_busy' as const },
    savedValues: {
      checksum: hash(final),
      inspection: 'complete' as const,
      counts: {
        formulaCount: 1,
        numericCacheCount: 0,
        booleanCacheCount: 0,
        stringCacheCount: 0,
        errorCacheCount: 0,
        missingCacheCount: 1,
        invalidCacheCount: 0,
        unsupportedCacheCount: 0,
        unsupportedFormulaCount: 0,
      },
    },
  };
  ports.quality.mockResolvedValue(checked);
  ports.workbench.mockReturnValue(workbench);
  ports.object.mockImplementation((arg) => ({ id: randomUUID(), ...arg }));
  ports.register.mockResolvedValue({
    seriesId: randomUUID(),
    version: 1,
    parentObjectId: null,
  });
  ports.publish.mockImplementation(async (arg) => ({
    id: randomUUID(),
    object: {
      id: randomUUID(),
      mediaType: arg.mediaType,
      checksum: hash(arg.bytes),
      sizeBytes: arg.bytes.length,
    },
    version: {
      seriesId: randomUUID(),
      version: 1,
      parentObjectId: null,
      changeSummary: null,
    },
    officeReceipt: arg.officeReceipt,
    officeReceiptReplayed: false,
  }));
  return { args, input, generated, checked };
}
const invoke = (f: ReturnType<typeof setup>) =>
  createWorkspaceExport({ input: f.input, arguments: f.args });

describe('Office receipts through existing publication ports', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  it.each([
    ['native', true],
    ['office', true],
    ['content', true],
    ['native', false],
    ['office', false],
    ['content', false],
  ] as const)(
    'preserves final bytes and identical facts for %s / workbench=%s',
    async (mode, workbench) => {
      const f = setup(mode, workbench);
      const result = JSON.parse((await invoke(f)).modelContent);
      const call = (workbench ? ports.publish : ports.register).mock
        .calls[0]![0];
      expect(call.officeReceipt).toEqual({
        quality: f.checked.quality,
        warnings: f.checked.warnings,
        savedValues: f.checked.savedValues,
        diagnostic: f.checked.diagnostic,
      });
      expect(result).toMatchObject(call.officeReceipt);
      expect(ports.quality).toHaveBeenCalledExactlyOnceWith(source, 'xlsx', {
        cloudQualityAllowed: true,
      });
      if (workbench) {
        expect(call.bytes).toEqual(final);
        expect(ports.put).not.toHaveBeenCalled();
        expect(ports.register).not.toHaveBeenCalled();
      } else {
        expect(call.object.checksum).toBe(hash(final));
        expect(call.object.sizeBytes).toBe(final.length);
        expect(ports.put).toHaveBeenCalledOnce();
        expect(ports.publish).not.toHaveBeenCalled();
      }
    },
  );
  it('uses the real local-only checker option while keeping the publisher unchanged', async () => {
    const f = setup();
    ports.native.mockResolvedValue({
      ...f.generated,
      cloudQualityAllowed: false,
    });
    await invoke(f);
    expect(ports.quality).toHaveBeenCalledExactlyOnceWith(source, 'xlsx', {
      cloudQualityAllowed: false,
    });
  });
  it.each([false, true])(
    'does not upgrade a cached publication, missing receipt=%s',
    async (missing) => {
      const f = setup();
      const old = {
        quality: {
          status: 'unavailable',
          reason: 'Original historical reason',
        },
        warnings: ['Original historical warning'],
      };
      ports.publish.mockResolvedValue({
        id: randomUUID(),
        object: {
          id: randomUUID(),
          mediaType: officeMediaTypes.xlsx,
          checksum: hash(final),
          sizeBytes: final.length,
        },
        version: { seriesId: randomUUID(), version: 1, parentObjectId: null },
        officeReceipt: missing ? null : old,
        officeReceiptReplayed: true,
      });
      const result = JSON.parse((await invoke(f)).modelContent);
      expect(result.savedValues).toBeUndefined();
      expect(result.diagnostic).toBeUndefined();
      expect(result.quality).toEqual(missing ? undefined : old.quality);
      expect(result.warnings).toEqual(missing ? [] : old.warnings);
    },
  );
  it('rejects final-byte mismatch before every storage/publication port and confirms only this attempt', async () => {
    const f = setup();
    ports.quality.mockResolvedValue({
      ...f.checked,
      savedValues: { ...f.checked.savedValues, checksum: hash(source) },
    });
    const error = await invoke(f).catch((value) => value);
    expect(error).toMatchObject({ code: 'OFFICE_DOCUMENT_INVALID' });
    expect(
      isConfirmedToolFailure(error, {
        runId: f.input.context.runId,
        callId: f.input.call.id,
        toolName: f.input.call.name,
      }),
    ).toBe(true);
    expect(ports.put).not.toHaveBeenCalled();
    expect(ports.publish).not.toHaveBeenCalled();
    expect(ports.register).not.toHaveBeenCalled();
  });
  it('keeps the original finite renderer cause when the existing required-quality rule stops publication', async () => {
    const f = setup();
    f.input.userRequest = '必须重算 Excel 公式后交付';
    const error = await invoke(f).catch((value) => value);
    expect(error).toMatchObject({ code: 'OFFICE_QUALITY_UNAVAILABLE' });
    expect(error.message).toContain('renderer/renderer_busy');
    expect(error.message).not.toContain('cache_missing');
    expect(ports.put).not.toHaveBeenCalled();
    expect(ports.publish).not.toHaveBeenCalled();
    expect(ports.register).not.toHaveBeenCalled();
  });
  it('does not accept model-provided saved facts or quality exemptions', async () => {
    const f = setup();
    Object.assign(f.args, {
      savedValues: { inspection: 'complete' },
      diagnostic: { code: 'passed' },
      officeReceipt: { quality: { status: 'passed' } },
      required: false,
    });
    const result = JSON.parse((await invoke(f)).modelContent);
    expect(result.savedValues).toEqual(f.checked.savedValues);
    expect(result.diagnostic).toEqual(f.checked.diagnostic);
  });
  it('preserves existing bounded formula excerpts on a fresh checked result', async () => {
    const f = setup();
    const formulas = [
      { sheet: 'Totals', cell: 'A1', formula: '1+1', type: 'n', value: 2 },
    ];
    ports.quality.mockResolvedValue({
      ...f.checked,
      quality: {
        status: 'checked',
        format: 'xlsx',
        pageCount: 1,
        formulaCount: 1,
        formulaErrorCount: 0,
        layout: 'rendered_not_visually_reviewed',
        formulas,
      },
      savedValues: {
        ...f.checked.savedValues,
        counts: {
          ...f.checked.savedValues.counts,
          numericCacheCount: 1,
          missingCacheCount: 0,
        },
      },
    });
    const result = JSON.parse((await invoke(f)).modelContent);
    expect(result.quality.formulas).toEqual(formulas);
    expect(
      ports.publish.mock.calls[0]![0].officeReceipt.quality.formulas,
    ).toBeUndefined();
  });
  it('keeps ordinary text outside Office checking', async () => {
    const f = setup('content');
    f.args.format = 'text';
    f.args.fileName = 'ordinary';
    ports.content.mockResolvedValue({
      bytes: source,
      mediaType: 'text/plain',
      extension: '.txt',
    });
    const result = JSON.parse((await invoke(f)).modelContent);
    expect(ports.quality).not.toHaveBeenCalled();
    expect(result.fileName).toBe('ordinary.txt');
    expect(result.savedValues).toBeUndefined();
    expect(result.diagnostic).toBeUndefined();
    expect(ports.publish.mock.calls[0]![0].officeReceipt).toBeUndefined();
  });
});
