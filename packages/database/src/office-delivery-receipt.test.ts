import { describe, expect, it } from 'vitest';
import { officeMediaTypes } from '@allrice/contracts';
import {
  parseOfficeDeliveryReceiptForObject,
  readBoundOfficeDeliveryReceipt,
} from './office-delivery-receipt.ts';

const output = {
  objectId: '00000000-0000-4000-8000-000000000001',
  runId: '00000000-0000-4000-8000-000000000002',
  checksum: `sha256:${'a'.repeat(64)}`,
  format: 'xlsx',
  mediaType: officeMediaTypes.xlsx,
};
const oldReceipt = {
  quality: {
    status: 'unavailable' as const,
    reason: 'Original unknown failure',
  },
  warnings: ['Original unknown failure'],
};
const receipt = {
  ...oldReceipt,
  diagnostic: { stage: 'renderer' as const, code: 'renderer_busy' as const },
  savedValues: {
    checksum: output.checksum,
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
const metadata = () => ({
  objectId: output.objectId,
  runId: output.runId,
  checksum: output.checksum,
  receipt,
});

describe('Office audit byte and Run binding (pure metadata, no DB)', () => {
  it('preserves the failure stage and saved-byte facts through JSON storage', () => {
    const persisted = JSON.parse(JSON.stringify(metadata()));
    expect(readBoundOfficeDeliveryReceipt(persisted, output)).toEqual(receipt);
  });
  it.each([
    { checksum: `sha256:${'b'.repeat(64)}` },
    { format: 'docx' },
    { mediaType: officeMediaTypes.docx },
  ])('rejects a new receipt for a different final object %j', (override) => {
    expect(() =>
      parseOfficeDeliveryReceiptForObject(receipt, { ...output, ...override }),
    ).toThrow(/office_receipt_(?:checksum|format)_mismatch/);
  });
  it.each([
    { objectId: '00000000-0000-4000-8000-000000000003' },
    { runId: '00000000-0000-4000-8000-000000000003' },
    { checksum: `sha256:${'c'.repeat(64)}` },
    {
      receipt: {
        ...receipt,
        savedValues: {
          ...receipt.savedValues,
          checksum: `sha256:${'d'.repeat(64)}`,
        },
      },
    },
  ])(
    'does not read another object, Run, version checksum or forged inner facts %j',
    (override) => {
      expect(
        readBoundOfficeDeliveryReceipt({ ...metadata(), ...override }, output),
      ).toBeNull();
    },
  );
  it('does not upgrade the original receipt using a retry of the same bytes', () => {
    const original = { ...metadata(), receipt: oldReceipt };
    const retry = parseOfficeDeliveryReceiptForObject(receipt, output);
    expect(retry.savedValues).toBeDefined();
    const read = readBoundOfficeDeliveryReceipt(original, output);
    expect(read).toEqual(oldReceipt);
    expect(read?.savedValues).toBeUndefined();
    expect(read?.diagnostic).toBeUndefined();
  });
  it('retains old receipts even on a non-Office historical record, with no new defaults', () => {
    expect(
      parseOfficeDeliveryReceiptForObject(oldReceipt, {
        ...output,
        format: 'text',
        mediaType: 'text/plain',
      }),
    ).toEqual(oldReceipt);
  });
  it.each([{ format: 'docx' }, { mediaType: officeMediaTypes.docx }])(
    'binds a checked renderer receipt even without saved values %j',
    (override) => {
      const checked = {
        quality: {
          status: 'checked',
          format: 'xlsx',
          pageCount: 1,
          formulaCount: 1,
          formulaErrorCount: 0,
          layout: 'rendered_not_visually_reviewed',
        },
        warnings: [],
      };
      const differentOutput = { ...output, ...override };
      expect(() =>
        parseOfficeDeliveryReceiptForObject(checked, differentOutput),
      ).toThrow('office_receipt_format_mismatch');
      expect(
        readBoundOfficeDeliveryReceipt(
          { ...metadata(), receipt: checked },
          differentOutput,
        ),
      ).toBeNull();
      expect(parseOfficeDeliveryReceiptForObject(checked, output)).toEqual(
        checked,
      );
    },
  );
  it('keeps a missing or malformed persisted receipt unknown', () => {
    for (const value of [
      undefined,
      null,
      {},
      { ...metadata(), receipt: { quality: { status: 'passed' } } },
    ])
      expect(readBoundOfficeDeliveryReceipt(value, output)).toBeNull();
  });
  it('does not infer a Run binding from null historical provenance', () => {
    expect(
      readBoundOfficeDeliveryReceipt(
        { ...metadata(), runId: null },
        { ...output, runId: null },
      ),
    ).toBeNull();
  });
});
