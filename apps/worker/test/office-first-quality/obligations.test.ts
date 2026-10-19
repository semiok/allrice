import { describe, expect, it } from 'vitest';
import {
  buildOfficeFirstDeliveryRequirements,
  readCanonicalOfficeExportProducer,
} from '../../../../packages/database/src/artifact-review.ts';
import { checkFinalDelivery } from '../../src/final-delivery/policy.js';
import { createDeliveryMarkup } from '../../src/final-delivery/markup.js';
import { id, run, oldRun, version, snapshot, receipt } from './fixtures.js';

const decide = (versions: ReturnType<typeof version>[], links: number[]) => {
  const facts = snapshot(
    versions,
    buildOfficeFirstDeliveryRequirements(versions, [run]),
  );
  return checkFinalDelivery({
    candidate: links
      .map((n) => `[file](/api/v1/files/${id(10 + n)}/download)`)
      .join('\n'),
    snapshot: facts,
    expectedScope: facts.scope,
    managedOrigins: [],
    markup: createDeliveryMarkup(),
  });
};
describe('canonical Office producer and exact series obligations', () => {
  it('binds independent producer identity to call/object/run/session/checksum', () => {
    const output = { ...version(), sessionId: id(60) };
    const metadata = {
      runId: run,
      sessionId: output.sessionId,
      checksum: output.checksum,
      kind: 'document',
      officeExport: {
        version: 1,
        tool: 'workspace.export.create',
        callId: output.publicationCallId,
        objectId: output.objectId,
      },
    };
    expect(readCanonicalOfficeExportProducer(metadata, output)).toEqual(
      metadata.officeExport,
    );
    for (const changes of [
      { runId: oldRun },
      { sessionId: id(61) },
      { checksum: 'sha256:' + 'b'.repeat(64) },
      { officeExport: { ...metadata.officeExport, callId: 'other' } },
      { officeExport: { ...metadata.officeExport, objectId: id(99) } },
      { officeExport: { ...metadata.officeExport, tool: 'python.execute' } },
      { officeExport: null },
    ])
      expect(() =>
        readCanonicalOfficeExportProducer({ ...metadata, ...changes }, output),
      ).toThrow('final_delivery_evidence_unavailable');
    expect(() =>
      readCanonicalOfficeExportProducer(
        { ...metadata, officeExport: undefined },
        output,
      ),
    ).toThrow('final_delivery_evidence_unavailable');
  });
  it('does not infer a producer from a quality receipt, name, or inherited read', () => {
    expect(
      readCanonicalOfficeExportProducer(
        { receipt: receipt() },
        { ...version(), sessionId: id(60) },
      ),
    ).toBeNull();
    expect(() =>
      buildOfficeFirstDeliveryRequirements(
        [{ ...version(), producerAuditId: null }],
        [run],
      ),
    ).toThrow('final_delivery_evidence_unavailable');
    expect(
      buildOfficeFirstDeliveryRequirements(
        [{ ...version(), originRunId: oldRun }],
        [run],
      ),
    ).toEqual([]);
    expect(
      buildOfficeFirstDeliveryRequirements(
        [
          {
            ...version(),
            provenanceKind: 'tool_result',
            producerAuditId: null,
          },
        ],
        [run],
      ),
    ).toEqual([]);
  });
  it('retains a canonical output with no quality receipt as an incomplete obligation', () => {
    const value = { ...version(), receipts: [] };
    expect(buildOfficeFirstDeliveryRequirements([value], [run])).toHaveLength(
      1,
    );
    expect(decide([value], [1]).status).toBe('invalid_response');
  });
  it('allows same-series v2 repair while preserving v1 failure and rejects links to failed v1', () => {
    const values = [version(1, 'missing', 2), version(2, 'good', 2)];
    const before = JSON.stringify(values[0]);
    expect(decide(values, [2]).status).toBe('valid');
    expect(decide(values, [1, 2]).status).toBe('invalid_response');
    expect(decide(values, [1]).status).toBe('invalid_response');
    expect(JSON.stringify(values[0])).toBe(before);
  });
  it('does not let same-name new series, another Run, a changed format, or constants repair the formula series', () => {
    expect(
      decide(
        [version(1, 'missing'), { ...version(2), seriesId: id(31) }],
        [1, 2],
      ).status,
    ).toBe('invalid_response');
    const foreign = [
      version(1, 'missing', 2),
      { ...version(2), originRunId: oldRun },
    ];
    expect(
      buildOfficeFirstDeliveryRequirements(foreign, [run])[0]?.expected,
    ).toBeNull();
    expect(
      decide([version(1, 'missing', 2), version(2, 'zero', 2)], [2]).status,
    ).toBe('invalid_response');
    const changed = [
      version(1, 'missing', 2),
      {
        ...version(2),
        format: 'pdf',
        mediaType: 'application/pdf',
        producerAuditId: null,
      },
    ];
    expect(
      buildOfficeFirstDeliveryRequirements(changed, [run])[0]?.expected,
    ).toBeNull();
  });
  it('leaves an ordinary zero-formula workbook not applicable and rejects conflicting fixed facts', () => {
    expect(
      buildOfficeFirstDeliveryRequirements([version(1, 'zero')], [run]),
    ).toEqual([]);
    expect(() =>
      buildOfficeFirstDeliveryRequirements(
        [{ ...version(), receipts: [receipt(), receipt('zero')] }],
        [run],
      ),
    ).toThrow('final_delivery_evidence_unavailable');
  });
  it('validates the small internal whenLinked condition rather than accepting false or source upgrades', () => {
    const values = [version(1, 'missing', 2), version(2, 'good', 2)];
    const facts = snapshot(
      values,
      buildOfficeFirstDeliveryRequirements(values, [run]),
    );
    const result = checkFinalDelivery({
      candidate: `[head](/api/v1/files/${id(12)}/download)`,
      snapshot: {
        ...facts,
        requirements: facts.requirements.map((r) =>
          r.whenLinked ? { ...r, whenLinked: false as unknown as true } : r,
        ),
      },
      expectedScope: facts.scope,
      managedOrigins: [],
      markup: createDeliveryMarkup(),
    });
    expect(result.status).toBe('evidence_unavailable');
  });
});
