import { describe, expect, it } from 'vitest';
import {
  OfficeDeliveryReceiptSchema,
  OfficeQualityDiagnosticSchema,
  XlsxSavedValuesSchema,
} from './office-quality.ts';

const counts = {
  formulaCount: 5,
  numericCacheCount: 1,
  booleanCacheCount: 1,
  stringCacheCount: 1,
  errorCacheCount: 1,
  missingCacheCount: 1,
  invalidCacheCount: 0,
  unsupportedCacheCount: 0,
  unsupportedFormulaCount: 0,
};
const facts = () => ({
  checksum: `sha256:${'a'.repeat(64)}`,
  inspection: 'complete' as const,
  counts: { ...counts },
});
const legacy = () => ({
  quality: { status: 'unavailable' as const, reason: 'Original unavailable' },
  warnings: ['Original unavailable'],
});

describe('Office receipt saved-byte contracts', () => {
  it('retains the historical shape without inventing inspection or diagnosis', () => {
    const receipt = OfficeDeliveryReceiptSchema.parse(legacy());
    expect(receipt).toEqual(legacy());
    expect('savedValues' in receipt).toBe(false);
    expect('diagnostic' in receipt).toBe(false);
  });
  it('retains missing/error counts separately from complete enumeration', () => {
    const receipt = OfficeDeliveryReceiptSchema.parse({
      ...legacy(),
      savedValues: facts(),
      diagnostic: { stage: 'renderer', code: 'renderer_busy' },
    });
    expect(receipt.savedValues).toEqual(facts());
    expect(receipt.quality.status).toBe('unavailable');
    expect(receipt.diagnostic).toEqual({
      stage: 'renderer',
      code: 'renderer_busy',
    });
  });
  it('keeps partial observed counters distinct from final totals', () => {
    const incomplete = {
      checksum: facts().checksum,
      inspection: 'incomplete',
      code: 'invalid_formula',
      observed: { ...counts, formulaCount: 6 },
    };
    expect(XlsxSavedValuesSchema.parse(incomplete)).toEqual(incomplete);
    expect(
      XlsxSavedValuesSchema.safeParse({ ...incomplete, counts }).success,
    ).toBe(false);
  });
  it.each([
    { checksum: 'sha256:bad' },
    { counts: { ...counts, formulaCount: 4 } },
    { counts: { ...counts, formulaCount: 6 } },
    { counts: { ...counts, numericCacheCount: -1 } },
    { counts: { ...counts, formulaCount: 10_001 } },
    { counts: { ...counts, unsupportedFormulaCount: 1 } },
    { counts: { ...counts, stringCacheCount: 0, unsupportedCacheCount: 1 } },
  ])('rejects malformed or misleading final facts %j', (override) => {
    expect(
      XlsxSavedValuesSchema.safeParse({ ...facts(), ...override }).success,
    ).toBe(false);
  });
  it('accepts a zero-formula workbook as byte facts without claiming a task verdict', () => {
    const zero = Object.fromEntries(Object.keys(counts).map((key) => [key, 0]));
    expect(
      XlsxSavedValuesSchema.safeParse({ ...facts(), counts: zero }).success,
    ).toBe(true);
  });
  it('rejects XLSX facts attached to a checked Word receipt', () => {
    expect(
      OfficeDeliveryReceiptSchema.safeParse({
        quality: {
          status: 'checked',
          format: 'docx',
          pageCount: 1,
          formulaCount: 0,
          formulaErrorCount: 0,
          layout: 'rendered_not_visually_reviewed',
        },
        warnings: [],
        savedValues: facts(),
      }).success,
    ).toBe(false);
  });
  it.each([
    { stage: 'renderer', code: 'cloud_quality_disallowed' },
    { stage: 'transport', code: 'renderer_busy' },
    { stage: 'cache_patch', code: 'private exception body' },
    {
      stage: 'renderer',
      code: 'renderer_busy',
      message: 'private path or stderr',
    },
    { stage: 'unknown', code: 'render_failed' },
  ])('rejects untrusted diagnostic data %j', (diagnostic) => {
    expect(OfficeQualityDiagnosticSchema.safeParse(diagnostic).success).toBe(
      false,
    );
  });
});
