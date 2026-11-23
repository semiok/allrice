import { describe, expect, it } from 'vitest';
import {
  MemoryAdminDetailQueryProjectionSchema,
  MemoryAdminListQueryProjectionSchema,
  MemoryAdminQueryProjectionSchema,
  MemoryCorrectCommandProjectionSchema,
  MemoryDetailQueryProjectionSchema,
  MemoryMutationCommandProjectionSchema,
  MemorySourceQueryProjectionSchema,
  MemorySourceViewProjectionSchema,
} from './employee-memory-port.ts';

const id = '11111111-1111-4111-8111-111111111111';
const digest = `sha256:${'a'.repeat(64)}`;
const target = { workspaceId: id, memoryId: id };
const mutation = {
  instanceId: id,
  expectedRevision: 1,
  pairDigest: digest,
  idempotencyKey: id,
};

describe('memory public management selectors', () => {
  it('keeps source personal/admin selectors strict and distinct from authority', () => {
    const personal = { ...target, instanceId: id };
    const admin = {
      organizationId: id,
      ownerId: id,
      instanceId: id,
      memoryId: id,
    };
    expect(MemorySourceQueryProjectionSchema.parse(personal)).toEqual(personal);
    expect(MemorySourceQueryProjectionSchema.parse(admin)).toEqual(admin);
    for (const input of [
      { ...personal, ...admin },
      { ...personal, expectedRevision: 1 },
      { ...admin, approved: true },
      { ...personal, sourceId: id },
    ])
      expect(MemorySourceQueryProjectionSchema.safeParse(input).success).toBe(
        false,
      );
  });

  it('exposes only actual stored source fields, preserving a blank label without inventing provenance', () => {
    const source = {
      sourceType: 'message',
      sourceLabel: '',
      capturedAt: '2020-01-02T03:04:05.000Z',
    };
    expect(MemorySourceViewProjectionSchema.parse(source)).toEqual(source);
    for (const field of [
      'memoryId',
      'revision',
      'pairDigest',
      'sourceId',
      'metadata',
      'details',
    ])
      expect(
        MemorySourceViewProjectionSchema.safeParse({ ...source, [field]: id })
          .success,
      ).toBe(false);
    expect(
      MemorySourceViewProjectionSchema.safeParse({
        ...source,
        sourceType: 'adopted-steering',
      }).success,
    ).toBe(false);
    expect(
      MemorySourceViewProjectionSchema.safeParse({
        ...source,
        capturedAt: null,
      }).success,
    ).toBe(false);
  });

  it('keeps detail scoped to the selected workspace, instance and record', () => {
    const query = { ...target, instanceId: id };
    expect(MemoryDetailQueryProjectionSchema.parse(query)).toEqual(query);
    for (const extra of [
      { ownerId: id },
      { organizationId: id },
      { approved: true },
      { runId: id },
    ])
      expect(
        MemoryDetailQueryProjectionSchema.safeParse({ ...query, ...extra })
          .success,
      ).toBe(false);
  });

  it('requires the complete edited pair and preserves explicit null as clearing', () => {
    const body = { ...mutation, summary: '周报先给风险', reason: '本人编辑' };
    expect(
      MemoryCorrectCommandProjectionSchema.safeParse({ target, body }).success,
    ).toBe(false);
    expect(
      MemoryCorrectCommandProjectionSchema.parse({
        target,
        body: { ...body, details: null },
      }).body.details,
    ).toBeNull();
    expect(
      MemoryCorrectCommandProjectionSchema.parse({
        target,
        body: { ...body, details: '只用于当前员工的周报' },
      }).body.details,
    ).toBe('只用于当前员工的周报');
  });

  it('does not accept a write without pair CAS or a model-supplied approval', () => {
    expect(
      MemoryMutationCommandProjectionSchema.parse({ target, body: mutation }),
    ).toEqual({ target, body: mutation });
    for (const key of ['expectedRevision', 'pairDigest', 'idempotencyKey']) {
      const body: Record<string, unknown> = { ...mutation };
      delete body[key];
      expect(
        MemoryMutationCommandProjectionSchema.safeParse({ target, body })
          .success,
      ).toBe(false);
    }
    expect(
      MemoryMutationCommandProjectionSchema.safeParse({
        target,
        body: { ...mutation, approved: true },
      }).success,
    ).toBe(false);
  });

  it('gives admin list and detail distinct strict targets without an optional detail id', () => {
    const query = { organizationId: id, ownerId: id, instanceId: id };
    expect(MemoryAdminListQueryProjectionSchema.parse(query)).toEqual(query);
    expect(
      MemoryAdminDetailQueryProjectionSchema.safeParse(query).success,
    ).toBe(false);
    const detail = { ...query, memoryId: id };
    expect(MemoryAdminDetailQueryProjectionSchema.parse(detail)).toEqual(
      detail,
    );
    expect(MemoryAdminListQueryProjectionSchema.safeParse(detail).success).toBe(
      false,
    );
    expect(MemoryAdminQueryProjectionSchema.parse(detail)).toEqual(detail);
    expect(
      MemoryAdminQueryProjectionSchema.safeParse({ ...detail, actor: id })
        .success,
    ).toBe(false);
  });
});
