import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DeliverableCaptureReferenceQuerySchema,
  MaterialsFilePublicationInputProjectionSchema,
  MaterialsPreparedReferenceQuerySchema,
  PanelWriteReceiptQuerySchema,
  PanelWriteReceiptSchema,
} from './index.ts';

describe('named panel owner projections', () => {
  const workspaceId = randomUUID(),
    sourceId = randomUUID(),
    revisionId = randomUUID(),
    requestId = randomUUID();
  it('requires all exact prepared-reference selectors and forbids history enumeration', () => {
    expect(
      MaterialsPreparedReferenceQuerySchema.parse({
        workspaceId,
        sourceId,
        revisionId,
      }),
    ).toEqual({ workspaceId, sourceId, revisionId });
    expect(
      MaterialsPreparedReferenceQuerySchema.safeParse({ workspaceId, sourceId })
        .success,
    ).toBe(false);
    expect(
      MaterialsPreparedReferenceQuerySchema.safeParse({
        workspaceId,
        sourceId,
        revisionId,
        latest: true,
      }).success,
    ).toBe(false);
  });
  it('does not let capture selectors carry a viewer, tenant, raw path or authorization assertion', () => {
    const input = { workspaceId, objectId: randomUUID(), requestId };
    expect(DeliverableCaptureReferenceQuerySchema.parse(input)).toEqual(input);
    for (const injected of [
      { viewerId: randomUUID() },
      { organizationId: randomUUID() },
      { path: '/private/bytes' },
      { allowed: true },
    ])
      expect(
        DeliverableCaptureReferenceQuerySchema.safeParse({
          ...input,
          ...injected,
        }).success,
      ).toBe(false);
  });
  it('file publication remains the existing independent fixed-copy command', () => {
    const input = {
      origin: 'file',
      workspaceId,
      requestId,
      objectId: randomUUID(),
      purpose: '',
      audience: { scope: 'personal', departmentIds: [] },
    };
    expect(MaterialsFilePublicationInputProjectionSchema.parse(input)).toEqual(
      input,
    );
    expect(
      MaterialsFilePublicationInputProjectionSchema.safeParse({
        ...input,
        contentBase64: 'YWJj',
      }).success,
    ).toBe(false);
    expect(
      MaterialsFilePublicationInputProjectionSchema.safeParse({
        ...input,
        sourceId,
      }).success,
    ).toBe(false);
  });
  it.each([
    'publish-file',
    'publish-upload',
    'capture',
    'upload',
    'change-publication',
    'change-source',
  ] as const)(
    'reads the original %s key without a write payload',
    (operation) => {
      const input = { workspaceId, requestId, operation };
      expect(PanelWriteReceiptQuerySchema.parse(input)).toEqual(input);
      expect(
        PanelWriteReceiptQuerySchema.safeParse({ ...input, retry: true })
          .success,
      ).toBe(false);
      expect(
        PanelWriteReceiptQuerySchema.safeParse({
          ...input,
          requestId: 'new-key',
        }).success,
      ).toBe(false);
    },
  );
  it('unknown and pending reservations are different from a successful saved object', () => {
    const unknown = {
      requestId,
      operation: 'upload',
      status: 'unknown',
      inputDigest: null,
      result: null,
      ready: null,
    };
    expect(PanelWriteReceiptSchema.parse(unknown)).toEqual(unknown);
    const pending = {
      ...unknown,
      status: 'recorded',
      inputDigest: 'sha256:' + 'a'.repeat(64),
      result: { objectId: randomUUID() },
      ready: false,
    };
    expect(PanelWriteReceiptSchema.parse(pending)).toEqual(pending);
    expect(
      PanelWriteReceiptSchema.safeParse({ ...pending, storageKey: 'hidden' })
        .success,
    ).toBe(false);
  });
});
