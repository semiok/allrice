import type { OfficeDeliveryReceipt } from '@allrice/contracts';
import type { OfficeFirstDeliveryVersion } from '../../../../packages/database/src/artifact-review.ts';
import type { DeliverySnapshot } from '../../src/final-delivery/policy.js';

export const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const run = id(1),
  oldRun = id(2),
  checksum = `sha256:${'a'.repeat(64)}`;
export function receipt(
  kind: 'good' | 'missing' | 'error' | 'invalid' | 'zero' | 'unknown' = 'good',
): OfficeDeliveryReceipt {
  const counts = {
    formulaCount: kind === 'zero' ? 0 : 1,
    numericCacheCount: kind === 'good' ? 1 : 0,
    booleanCacheCount: 0,
    stringCacheCount: 0,
    errorCacheCount: kind === 'error' ? 1 : 0,
    missingCacheCount: kind === 'missing' || kind === 'unknown' ? 1 : 0,
    invalidCacheCount: kind === 'invalid' ? 1 : 0,
    unsupportedCacheCount: 0,
    unsupportedFormulaCount: 0,
  };
  return {
    quality: { status: 'unavailable', reason: 'renderer unavailable' },
    warnings: [],
    savedValues:
      kind === 'unknown'
        ? {
            checksum,
            inspection: 'incomplete',
            code: 'unsupported_formula',
            observed: counts,
          }
        : { checksum, inspection: 'complete', counts },
  };
}
export function version(
  n = 1,
  kind: Parameters<typeof receipt>[0] = 'good',
  latest = n,
): OfficeFirstDeliveryVersion {
  return {
    objectId: id(10 + n),
    versionId: id(20 + n),
    checksum,
    seriesId: id(30),
    version: n,
    latestVersionId: id(20 + latest),
    originRunId: run,
    kind: 'document',
    provenanceKind: 'model_proposal',
    format: 'xlsx',
    mediaType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    publicationCallId: `call-${n}`,
    producerAuditId: id(40 + n),
    receipts: [receipt(kind)],
  };
}
export function snapshot(
  versions: OfficeFirstDeliveryVersion[],
  requirements: DeliverySnapshot['requirements'],
): DeliverySnapshot {
  const scope = {
    organizationId: id(50),
    workspaceId: id(51),
    ownerId: id(52),
    sessionId: id(53),
  };
  return {
    scope: { ...scope, runId: run },
    complete: true,
    authorization: 'current',
    now: '2026-10-20T00:00:00.000Z',
    ownedRunIds: [run],
    explicitReferenceVersionIds: [],
    requirements,
    artifacts: versions.map((v) => ({
      objectId: v.objectId,
      versionId: v.versionId,
      checksum: v.checksum,
      scope,
      originRunId: v.originRunId,
      fileName: 'same-name.xlsx',
      state: 'ready',
      immutable: true,
      deletedAt: null,
      retentionUntil: null,
    })),
    checks: versions.flatMap((v) =>
      ['office.saved_values', 'office.formula_errors'].map((checkId) => ({
        objectId: v.objectId,
        versionId: v.versionId,
        checksum: v.checksum,
        scope,
        originRunId: v.originRunId,
        checkId,
        status:
          v.receipts.length &&
          v.receipts.every(
            (r) =>
              r?.savedValues?.inspection === 'complete' &&
              r.savedValues.counts.formulaCount > 0 &&
              r.savedValues.counts.missingCacheCount === 0 &&
              r.savedValues.counts.invalidCacheCount === 0 &&
              r.savedValues.counts.errorCacheCount === 0,
          )
            ? ('passed' as const)
            : ('unavailable' as const),
      })),
    ),
  };
}
