import { z } from 'zod';
import { UuidSchema } from './common.ts';
const text = z.string().trim().min(1).max(500);
const currency = z.enum(['CNY', 'USD']);
const minutes = z.number().finite().min(0).max(1_000_000);
const minor = z.number().int().min(0).max(1_000_000_000_000);
const period = {
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
};
export const InvestmentContentSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('baseline'),
      key: text,
      title: text,
      taskType: text,
      unit: text,
      minutesPerUnit: minutes,
      hourlyRateMinor: minor.nullable(),
      currency: currency.nullable(),
      source: text,
    })
    .strict()
    .refine(
      (v) => (v.hourlyRateMinor === null) === (v.currency === null),
      '费率与币种须一起填写',
    ),
  z
    .object({
      kind: z.literal('work'),
      key: text,
      title: text,
      units: z.number().finite().positive().max(100_000),
      sourceRunIds: z.array(UuidSchema).min(1).max(50),
      sourceVersionId: UuidSchema.nullable(),
      baselineRevisionId: UuidSchema.nullable(),
      adoptedAt: z.string().datetime({ offset: true }).nullable(),
      humanMinutes: minutes.nullable(),
      humanScope: z.enum(['complete', 'review_only']),
      source: text,
    })
    .strict()
    .refine(
      (v) => new Set(v.sourceRunIds).size === v.sourceRunIds.length,
      '来源工作不能重复',
    )
    .refine(
      (v) => !v.adoptedAt || !!v.sourceVersionId,
      '确认采用须选择具体成果版本',
    ),
  z
    .object({
      kind: z.literal('expense'),
      receiptKey: text,
      title: text,
      ...period,
      currency,
      amountMinor: minor,
      allocations: z
        .array(
          z.object({ organizationId: UuidSchema, amountMinor: minor }).strict(),
        )
        .max(500),
      source: text,
    })
    .strict()
    .refine((v) => Date.parse(v.to) > Date.parse(v.from), '期间无效')
    .refine(
      (v) =>
        new Set(v.allocations.map((a) => a.organizationId)).size ===
        v.allocations.length,
      '公司不能重复分摊',
    )
    .refine(
      (v) =>
        v.allocations.reduce((n, a) => n + a.amountMinor, 0) <= v.amountMinor,
      '分摊不得超过总费用',
    ),
  z
    .object({
      kind: z.literal('statement'),
      title: text,
      ...period,
      currency,
      modelMinor: minor.nullable(),
      otherMinor: minor.nullable(),
      subscriptionKnown: z.boolean(),
      subscriptionRevisionIds: z.array(UuidSchema).max(100),
      coverage: z.enum(['partial', 'complete']),
      standardHours: z.number().finite().positive().max(100_000).nullable(),
      source: text,
    })
    .strict()
    .refine((v) => Date.parse(v.to) > Date.parse(v.from), '期间无效')
    .refine(
      (v) =>
        new Set(v.subscriptionRevisionIds).size ===
        v.subscriptionRevisionIds.length,
      '订阅费用不能重复',
    ),
]);
export type InvestmentContent = z.infer<typeof InvestmentContentSchema>;
export type InvestmentBaseline = Extract<
  InvestmentContent,
  { kind: 'baseline' }
>;
export type InvestmentWork = Extract<InvestmentContent, { kind: 'work' }>;
export type InvestmentExpense = Extract<InvestmentContent, { kind: 'expense' }>;
export type InvestmentStatement = Extract<
  InvestmentContent,
  { kind: 'statement' }
>;
export const InvestmentMutationSchema = z
  .object({
    entryId: UuidSchema,
    expectedRevision: z.number().int().nonnegative(),
    content: InvestmentContentSchema,
  })
  .strict();
export const InvestmentRevisionSchema = z
  .object({
    id: UuidSchema,
    entryId: UuidSchema,
    number: z.number().int().positive(),
    organizationId: UuidSchema.nullable(),
    ownerId: UuidSchema,
    workspaceId: UuidSchema.nullable(),
    content: InvestmentContentSchema,
    facts: z.record(z.string(), z.unknown()),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    createdAt: z.string(),
    createdBy: UuidSchema,
  })
  .strict();
export type InvestmentRevision = z.infer<typeof InvestmentRevisionSchema>;
export interface InvestmentDirectory {
  entries: InvestmentRevision[];
  nextCursor: string | null;
}
export type InvestmentOmission =
  | 'not_adopted'
  | 'baseline_missing'
  | 'human_input_missing'
  | 'human_scope_incomplete'
  | 'source_unavailable'
  | 'calculation_out_of_range';
export interface InvestmentSample {
  revision: InvestmentRevision;
  baseline: InvestmentRevision | null;
  sourceAvailable: boolean;
  omissions: InvestmentOmission[];
  savedMinutes: number | null;
  valueMinor: number | null;
  currency: string | null;
}
export interface InvestmentReport {
  algorithm: 'allrice-human-savings-v1';
  organizationId: string;
  period: { from: string; to: string; timeZone: string };
  candidateWorks: number;
  includedWorks: number;
  returnedWorks: number;
  truncated: boolean;
  savedMinutes: number | null;
  missing: Record<InvestmentOmission, number>;
  groups: {
    currency: string;
    valuedWorks: number;
    unvaluedWorks: number;
    valueCoverage: 'unknown' | 'partial' | 'complete';
    valueMinor: number | null;
    modelMinor: number | null;
    subscriptionMinor: number | null;
    otherMinor: number | null;
    costMinor: number | null;
    costCoverage: 'unknown' | 'partial' | 'complete';
    ratio: number | null;
    roi: number | null;
    statement: InvestmentRevision | null;
    excludedCosts: string[];
  }[];
  standardHours: number | null;
  hoursEquivalent: number | null;
  samples: InvestmentSample[];
  generatedAt: string;
  scopeNote: string;
}

export const InvestmentDirectorySchema = z
  .object({
    entries: z.array(InvestmentRevisionSchema),
    nextCursor: UuidSchema.nullable(),
  })
  .strict();
const nullableNumber = z.number().finite().nullable();
const coverage = z.enum(['unknown', 'partial', 'complete']);
export const InvestmentReportSchema = z
  .object({
    algorithm: z.literal('allrice-human-savings-v1'),
    organizationId: UuidSchema,
    period: z
      .object({ from: z.string(), to: z.string(), timeZone: z.string() })
      .strict(),
    candidateWorks: z.number().int().nonnegative(),
    includedWorks: z.number().int().nonnegative(),
    returnedWorks: z.number().int().nonnegative(),
    truncated: z.boolean(),
    savedMinutes: nullableNumber,
    missing: z
      .object({
        not_adopted: z.number(),
        baseline_missing: z.number(),
        human_input_missing: z.number(),
        human_scope_incomplete: z.number(),
        source_unavailable: z.number(),
        calculation_out_of_range: z.number(),
      })
      .strict(),
    groups: z.array(
      z
        .object({
          currency,
          valuedWorks: z.number(),
          unvaluedWorks: z.number(),
          valueCoverage: coverage,
          valueMinor: nullableNumber,
          modelMinor: nullableNumber,
          subscriptionMinor: nullableNumber,
          otherMinor: nullableNumber,
          costMinor: nullableNumber,
          costCoverage: coverage,
          ratio: nullableNumber,
          roi: nullableNumber,
          statement: InvestmentRevisionSchema.nullable(),
          excludedCosts: z.array(z.string()),
        })
        .strict(),
    ),
    standardHours: nullableNumber,
    hoursEquivalent: nullableNumber,
    samples: z.array(
      z
        .object({
          revision: InvestmentRevisionSchema,
          baseline: InvestmentRevisionSchema.nullable(),
          sourceAvailable: z.boolean(),
          omissions: z.array(
            z.enum([
              'not_adopted',
              'baseline_missing',
              'human_input_missing',
              'human_scope_incomplete',
              'source_unavailable',
              'calculation_out_of_range',
            ]),
          ),
          savedMinutes: nullableNumber,
          valueMinor: nullableNumber,
          currency: currency.nullable(),
        })
        .strict(),
    ),
    generatedAt: z.string(),
    scopeNote: z.string(),
  })
  .strict();
