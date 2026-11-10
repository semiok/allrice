import { describe, expect, it } from 'vitest';
import {
  CorrectPersonalEmployeeMemoryInputSchema,
  CreatePersonalEmployeeMemoryInputSchema,
  PersonalMemoryPairSchema,
} from './personal-employee-memory.ts';
import { CreateWorkspaceMemoryInputSchema } from './workspace.ts';

const id = '00000000-0000-4000-8000-000000000001';
const input = {
  workspaceId: id,
  instanceId: id,
  idempotencyKey: id,
  summary: '习惯',
};
describe('personal pair storage contracts', () => {
  it('counts Unicode code points after summary line formatting, and keeps complete JSON detail', () => {
    const pair = {
      summary: '🧑'.repeat(40),
      details: '\t"\\\n' + '🧑'.repeat(1996),
    };
    expect(
      PersonalMemoryPairSchema.parse(JSON.parse(JSON.stringify(pair))),
    ).toEqual(pair);
    expect(
      PersonalMemoryPairSchema.safeParse({
        ...pair,
        summary: pair.summary + '字',
      }).success,
    ).toBe(false);
    expect(
      PersonalMemoryPairSchema.safeParse({
        ...pair,
        details: pair.details + '字',
      }).success,
    ).toBe(false);
    expect(
      PersonalMemoryPairSchema.parse({
        summary: '  月报\n不得外发  ',
        details: '  保留\n条件\t  ',
      }),
    ).toEqual({
      summary: '月报 不得外发',
      details: '  保留\n条件\t  ',
    });
    expect(
      PersonalMemoryPairSchema.parse({
        summary: 'e\u0301'.repeat(20),
        details: ' \n\t',
      }).details,
    ).toBeNull();
  });
  it.each(['\0', '\ud800', '\udfff'])(
    'rejects PostgreSQL/JSON unrepresentable text %j',
    (value) => {
      expect(
        PersonalMemoryPairSchema.safeParse({ summary: value, details: null })
          .success,
      ).toBe(false);
      expect(
        PersonalMemoryPairSchema.safeParse({ summary: '摘要', details: value })
          .success,
      ).toBe(false);
    },
  );
  it('requires explicit details for correction, accepts null, and forbids a third content body', () => {
    expect(
      CreatePersonalEmployeeMemoryInputSchema.parse(input).details,
    ).toBeNull();
    const create = {
      instanceId: id,
      idempotencyKey: id,
      summary: input.summary,
    };
    const edit = {
      ...create,
      expectedRevision: 1,
      pairDigest: 'sha256:' + 'a'.repeat(64),
      reason: '本人修改',
    };
    expect(
      CorrectPersonalEmployeeMemoryInputSchema.safeParse(edit).success,
    ).toBe(false);
    expect(
      CorrectPersonalEmployeeMemoryInputSchema.parse({ ...edit, details: null })
        .details,
    ).toBeNull();
    expect(
      CorrectPersonalEmployeeMemoryInputSchema.safeParse({
        ...edit,
        details: null,
        content: '第三正文',
      }).success,
    ).toBe(false);
    expect(
      CreatePersonalEmployeeMemoryInputSchema.safeParse({
        ...input,
        summary: '\u3000\t',
      }).success,
    ).toBe(false);
    // The shared original-source DTO is deliberately not replaced by pair limits.
    expect(
      CreateWorkspaceMemoryInputSchema.parse({
        content: '原文'.repeat(2000),
        sourceType: 'tool',
      }).content,
    ).toHaveLength(4000);
  });
});
