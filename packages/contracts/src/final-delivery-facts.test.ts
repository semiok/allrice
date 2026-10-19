import { describe, expect, it } from 'vitest';
import {
  serializeFinalDeliveryFacts,
  type FinalDeliveryFacts,
} from './final-delivery-facts.js';

const facts = (): FinalDeliveryFacts => ({
  scope: {
    organizationId: 'org',
    workspaceId: 'workspace',
    ownerId: 'owner',
    sessionId: 'session',
    runId: 'run',
  },
  complete: true,
  authorization: 'current',
  now: '2026-10-19T00:00:00Z',
  ownedRunIds: ['run', 'child'],
  explicitReferenceVersionIds: ['old'],
  artifacts: [
    {
      objectId: 'object',
      versionId: 'version',
      checksum: 'first',
      retentionUntil: '2026-10-20T00:00:00Z',
      state: 'ready',
    },
  ],
  checks: [{ checkId: 'office.saved_values', status: 'passed' }],
  requirements: [{ id: 'sheet', expected: 'version', requireLink: true }],
  qualityReceipts: [
    {
      auditId: 'audit',
      receipt: { status: 'checked', orderedSteps: ['render', 'inspect'] },
    },
  ],
});

describe('shared final delivery fact identity', () => {
  it('stays stable as observation time advances without hiding expiration facts', () => {
    const a = facts();
    const b = { ...a, now: '2026-10-21T00:00:00Z' };
    expect(serializeFinalDeliveryFacts(a)).toBe(serializeFinalDeliveryFacts(b));
    expect(serializeFinalDeliveryFacts(b)).toContain('2026-10-20T00:00:00Z');
  });
  it('ignores set and object-key traversal order, preserving repeated facts', () => {
    const a = facts();
    const b = facts();
    b.ownedRunIds = ['child', 'run'];
    b.scope = {
      runId: 'run',
      sessionId: 'session',
      ownerId: 'owner',
      workspaceId: 'workspace',
      organizationId: 'org',
    };
    expect(serializeFinalDeliveryFacts(a)).toBe(serializeFinalDeliveryFacts(b));
    b.ownedRunIds = ['child', 'run', 'run'];
    expect(serializeFinalDeliveryFacts(a)).not.toBe(
      serializeFinalDeliveryFacts(b),
    );
  });
  it.each([
    'scope',
    'complete',
    'authorization',
    'ownedRunIds',
    'explicitReferenceVersionIds',
    'artifacts',
    'checks',
    'requirements',
    'qualityReceipts',
  ] as const)('binds changed %s facts', (key) => {
    const a = facts();
    const b = facts();
    const changed: Record<string, unknown> = {
      scope: { ownerId: 'other' },
      complete: false,
      authorization: 'revoked',
      ownedRunIds: ['run'],
      explicitReferenceVersionIds: [],
      artifacts: [],
      checks: [],
      requirements: [],
      qualityReceipts: [],
    };
    Object.assign(b, { [key]: changed[key] });
    expect(serializeFinalDeliveryFacts(a)).not.toBe(
      serializeFinalDeliveryFacts(b),
    );
  });
  it('preserves meaningful order within quality receipts', () => {
    const a = facts();
    const b = facts();
    b.qualityReceipts = [
      {
        auditId: 'audit',
        receipt: { status: 'checked', orderedSteps: ['inspect', 'render'] },
      },
    ];
    expect(serializeFinalDeliveryFacts(a)).not.toBe(
      serializeFinalDeliveryFacts(b),
    );
  });
  it('retains failed and unavailable receipts rather than picking a successful one', () => {
    const a = facts();
    const b = facts();
    b.qualityReceipts = [
      ...b.qualityReceipts!,
      { auditId: 'second', receipt: null },
    ];
    expect(serializeFinalDeliveryFacts(a)).not.toBe(
      serializeFinalDeliveryFacts(b),
    );
  });
  it.each([undefined, NaN, Infinity, new Date(), () => true])(
    'refuses facts that cannot have an exact JSON identity',
    (invalid) => {
      const a = facts();
      a.qualityReceipts = [{ receipt: invalid }];
      expect(() => serializeFinalDeliveryFacts(a)).toThrow(
        'final_delivery_non_json_fact',
      );
    },
  );
});
