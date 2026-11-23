import { describe, expect, it } from 'vitest';
import {
  MemoryAdminDetailQueryProjectionSchema,
  MemoryAdminListQueryProjectionSchema,
  MemoryAdminQueryProjectionSchema,
  MemoryCorrectCommandProjectionSchema,
  MemoryDetailQueryProjectionSchema,
  MemoryMutationCommandProjectionSchema,
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
