import { describe, expect, it } from 'vitest';
import {
  assessOfficeFormulaCaches,
  EmployeeExecutionSnapshotV2Schema,
  OfficeFirstDeliveryPolicySchema,
} from '@allrice/contracts';
import { freezeOfficeFirstDeliverySnapshot } from '../../../../packages/database/src/execution/queue.ts';
import { checksum, receipt } from './fixtures.js';

describe('first Office quality technical boundary', () => {
  it.each(['missing', 'error', 'invalid', 'unknown'] as const)(
    'keeps %s incomplete even when a file exists',
    (kind) => {
      expect(assessOfficeFormulaCaches(receipt(kind))).toMatchObject({
        status: 'incomplete',
        hasFormulas: true,
      });
    },
  );
  it('accepts complete typed cache facts without upgrading an unavailable renderer', () => {
    const value = receipt();
    expect(assessOfficeFormulaCaches(value)).toEqual({
      status: 'satisfied',
      hasFormulas: true,
      reason: 'cache_present',
    });
    expect(value.quality.status).toBe('unavailable');
  });
  it.each(['booleanCacheCount', 'stringCacheCount'] as const)(
    'does not impose numeric semantics on %s',
    (key) => {
      const value = receipt();
      if (value.savedValues?.inspection !== 'complete') throw Error('fixture');
      value.savedValues.counts.numericCacheCount = 0;
      value.savedValues.counts[key] = 1;
      expect(assessOfficeFormulaCaches(value).status).toBe('satisfied');
    },
  );
  it('does not call zero formulas passed or clear an existing formula obligation with constants', () => {
    expect(assessOfficeFormulaCaches(receipt('zero'))).toMatchObject({
      status: 'not_applicable',
      hasFormulas: false,
    });
    expect(assessOfficeFormulaCaches(receipt('zero'), true)).toMatchObject({
      status: 'incomplete',
      reason: 'formula_output_missing',
    });
  });
  it('keeps old missing savedValues unknown and rejects count disagreement with a checked renderer', () => {
    expect(
      assessOfficeFormulaCaches({
        quality: { status: 'unavailable', reason: 'old' },
        warnings: [],
      }).status,
    ).toBe('incomplete');
    expect(
      assessOfficeFormulaCaches({
        ...receipt(),
        quality: {
          status: 'checked',
          format: 'xlsx',
          pageCount: 1,
          formulaCount: 2,
          formulaErrorCount: 0,
          layout: 'rendered_not_visually_reviewed',
        },
      }),
    ).toMatchObject({ reason: 'formula_count_mismatch' });
  });
  it('new server snapshot projection overwrites opt-out and strips copied markers in unsupported scopes', () => {
    const source = {
      officeFirstDeliveryPolicy: 'attacker-value',
      finalDeliveryPolicy: { version: 1, mode: 'legacy' },
      createdAt: 'original',
    } as unknown as Parameters<typeof freezeOfficeFirstDeliverySnapshot>[0];
    expect(
      freezeOfficeFirstDeliverySnapshot(
        source,
        true,
        'sha256:' + 'a'.repeat(64),
      ).officeFirstDeliveryPolicy,
    ).toBe('xlsx_formula_cache_v1');
    expect(freezeOfficeFirstDeliverySnapshot(source, false)).not.toHaveProperty(
      'officeFirstDeliveryPolicy',
    );
    expect(freezeOfficeFirstDeliverySnapshot(source, false)).not.toHaveProperty(
      'finalDeliveryPolicy',
    );
    expect(
      freezeOfficeFirstDeliverySnapshot(
        source,
        true,
        'sha256:' + 'a'.repeat(64),
      ).finalDeliveryPolicy,
    ).toEqual({
      version: 1,
      mode: 'checked_native_v1',
      artifactId: 'sha256:' + 'a'.repeat(64),
    });
    expect(
      EmployeeExecutionSnapshotV2Schema.shape.finalDeliveryPolicy.parse(
        undefined,
      ),
    ).toBeUndefined();
    expect(source.officeFirstDeliveryPolicy).toBe('attacker-value');
    expect(
      EmployeeExecutionSnapshotV2Schema.shape.officeFirstDeliveryPolicy.parse(
        undefined,
      ),
    ).toBeUndefined();
    expect(() => OfficeFirstDeliveryPolicySchema.parse(false)).toThrow();
  });
  it('keeps final checksum facts unchanged during assessment', () => {
    const value = receipt(),
      before = JSON.stringify(value);
    assessOfficeFormulaCaches(value);
    expect(JSON.stringify(value)).toBe(before);
    expect(value.savedValues?.checksum).toBe(checksum);
  });
});
