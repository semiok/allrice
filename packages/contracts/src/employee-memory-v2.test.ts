import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  EmployeeMemoryCountsSchema,
  EmployeeMemoryRowSchema,
  EmployeeMemoryRecordSchema,
  EmployeeMemoryListSchema,
  EmployeeMemoryListQuerySchema,
  EmployeeMemoryWriteResponseSchema,
  EmployeeMemoryMutationInputSchema,
} from './personal-employee-memory.ts';
import { ApiErrorSchema, MemoryConflictDetailsSchema } from './api.ts';
const id = randomUUID();
const row = {
  id,
  summary: '例外条件放说明',
  hasDetails: true,
  state: 'active' as const,
  revision: 1,
  pairDigest: 'sha256:' + 'a'.repeat(64),
  capturedAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
describe('memory v2 browser contracts', () => {
  it('keeps a strict minimal summary row distinct from a complete record and real capturedAt', () => {
    expect(EmployeeMemoryRowSchema.parse(row)).toEqual(row);
    const record = { ...row, details: '末尾否定不得丢失' };
    expect(EmployeeMemoryRecordSchema.parse(record)).toEqual(record);
    expect(
      EmployeeMemoryRecordSchema.safeParse({ ...record, hasDetails: false })
        .success,
    ).toBe(false);
    expect(
      EmployeeMemoryRecordSchema.safeParse({ ...record, details: null })
        .success,
    ).toBe(false);
    for (const extra of [
      { details: '不进列表' },
      { content: '旧正文' },
      { sourceId: id },
      { sourceExcerpt: '聊天原文' },
      { pinOrder: 1 },
      { expiresAt: null },
      { ownerId: id },
      { createdAt: row.capturedAt },
    ])
      expect(
        EmployeeMemoryRowSchema.safeParse({ ...row, ...extra }).success,
      ).toBe(false);
    expect(
      EmployeeMemoryRecordSchema.parse({
        ...row,
        details: null,
        hasDetails: false,
      }).details,
    ).toBeNull();
    expect(
      EmployeeMemoryRecordSchema.safeParse({ ...record, details: undefined })
        .success,
    ).toBe(false);
  });
  it('validates complete counts and groups, forbids pagination/filter/preview, and requires full-pair CAS', () => {
    const page = {
      schemaVersion: 2,
      workspaceId: id,
      instanceId: id,
      counts: { active: 1, pending: 0, maxActive: 100 },
      active: [row],
      pending: [],
    };
    expect(EmployeeMemoryListSchema.parse(page)).toEqual(page);
    expect(
      EmployeeMemoryListSchema.safeParse({
        ...page,
        counts: { ...page.counts, active: 0 },
      }).success,
    ).toBe(false);
    expect(
      EmployeeMemoryListSchema.safeParse({
        ...page,
        active: [{ ...row, state: 'pending' }],
      }).success,
    ).toBe(false);
    expect(
      EmployeeMemoryCountsSchema.safeParse({ ...page.counts, active: 101 })
        .success,
    ).toBe(false);
    expect(
      EmployeeMemoryCountsSchema.parse({
        active: 100,
        pending: 10000,
        maxActive: 100,
      }).pending,
    ).toBe(10000);
    for (const extra of [
      { state: 'all' },
      { after: id },
      { search: '摘要' },
      { filter: 'pending' },
      { preview: 1 },
      { pin: true },
    ])
      expect(
        EmployeeMemoryListQuerySchema.safeParse({
          workspaceId: id,
          instanceId: id,
          ...extra,
        }).success,
      ).toBe(false);
    const mutation = {
      instanceId: id,
      expectedRevision: 1,
      pairDigest: row.pairDigest,
      idempotencyKey: id,
    };
    expect(EmployeeMemoryMutationInputSchema.parse(mutation)).toEqual(mutation);
    expect(
      EmployeeMemoryMutationInputSchema.safeParse({
        ...mutation,
        pairDigest: undefined,
        contentDigest: row.pairDigest,
      }).success,
    ).toBe(false);
    expect(
      EmployeeMemoryWriteResponseSchema.safeParse({
        schemaVersion: 2,
        memory: { ...row, details: '完整说明' },
        counts: page.counts,
      }).success,
    ).toBe(true);
  });
});

describe('strict memory conflicts inside the existing API error envelope', () => {
  const details = [
    { domain: 'employee_memory', reason: 'cas_conflict' },
    { domain: 'employee_memory', reason: 'idempotency_conflict' },
    {
      domain: 'employee_memory',
      reason: 'memory_limit_reached',
      counts: { active: 100, maxActive: 100 },
    },
    {
      domain: 'employee_memory',
      reason: 'contract_changed',
      requiredSchemaVersion: 2,
    },
  ] as const;
  const error = {
    code: 'CONFLICT',
    message: '当前记录已变化',
    requestId: id,
    retryable: false,
  };
  it.each(details)(
    'accepts only the exact $reason branch under CONFLICT',
    (detail) => {
      const value = { error: { ...error, details: detail } };
      expect(ApiErrorSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(
        value,
      );
      for (const invalid of [
        { error: { ...error, details: { ...detail, sourceId: id } } },
        { error: { ...error, details: detail, metadata: {} } },
        { error: { ...error, code: 'VALIDATION_FAILED', details: detail } },
        { error: { ...error, retryable: true, details: detail } },
        { error: { ...error, requestId: 'not-a-uuid', details: detail } },
        { ...value, metadata: {} },
      ])
        expect(ApiErrorSchema.safeParse(invalid).success).toBe(false);
    },
  );
  it('rejects fabricated quota counts, arbitrary metadata and mixed union fields', () => {
    for (const value of [
      {
        domain: 'employee_memory',
        reason: 'memory_limit_reached',
        counts: { active: 99, maxActive: 100 },
      },
      {
        domain: 'employee_memory',
        reason: 'memory_limit_reached',
        counts: { active: 100, maxActive: 100, pending: 1 },
      },
      {
        domain: 'employee_memory',
        reason: 'cas_conflict',
        requiredSchemaVersion: 2,
      },
      {
        domain: 'employee_memory',
        reason: 'contract_changed',
        requiredSchemaVersion: 1,
      },
      { domain: 'employee_memory', reason: 'other' },
    ])
      expect(MemoryConflictDetailsSchema.safeParse(value).success).toBe(false);
    expect(ApiErrorSchema.parse({ error })).toEqual({ error });
  });
});
