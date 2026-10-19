import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  officeDeliveryReceipt,
  officeDeliveryResultFields,
} from './delivery-receipt.js';
const bytes = Buffer.from('final saved bytes');
const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const receipt = () => ({
  quality: {
    status: 'unavailable' as const,
    reason: 'Original renderer failure',
  },
  warnings: ['Original renderer failure'],
  diagnostic: { stage: 'renderer' as const, code: 'renderer_busy' as const },
  savedValues: {
    checksum,
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
});
describe('Office receipt projection', () => {
  it('projects the same final facts while excluding byte buffers and extra renderer fields', () => {
    const checked = { ...receipt(), bytes, privateDetail: 'untrusted details' };
    const actual = officeDeliveryReceipt(bytes, checked);
    expect(actual).toEqual(receipt());
    expect(
      JSON.parse(JSON.stringify(officeDeliveryResultFields(actual))),
    ).toEqual(receipt());
  });
  it('rejects facts attached to the renderer input instead of the final saved bytes', () => {
    expect(() =>
      officeDeliveryReceipt(Buffer.from('different saved bytes'), receipt()),
    ).toThrow('Office 保存值事实与最终文件不一致');
  });
  it('keeps absent historical fields absent and null receipts unknown', () => {
    const legacy = { quality: receipt().quality, warnings: receipt().warnings };
    expect(officeDeliveryReceipt(bytes, legacy)).toEqual(legacy);
    expect(
      JSON.parse(JSON.stringify(officeDeliveryResultFields(null))),
    ).toEqual({ warnings: [] });
  });
  it('keeps an untyped or malformed publication projection unknown', () => {
    expect(
      JSON.parse(
        JSON.stringify(
          officeDeliveryResultFields({ quality: { status: 'passed' } }),
        ),
      ),
    ).toEqual({ warnings: [] });
  });
});
