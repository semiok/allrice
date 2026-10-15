import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import { EmployeeMethodSharedTargetSchema } from './employee-content.ts';
import {
  EmployeeMethodFileAssertionSchema,
  EmployeeMethodFileStageSchema,
  employeeMethodFileCase,
} from './employee-method-file-case.ts';

export const employeeMethodTestEnvironment = 'isolated-text-v1';
export const EmployeeMethodTestCaseIdSchema = z.enum([
  'cny-total-v1',
  'cny-file-flow-v1',
]);
export const EmployeeMethodTestStartSchema = z
  .object({
    sharedTarget: EmployeeMethodSharedTargetSchema.optional(),
    expectedRevision: z.number().int().positive(),
    candidateRevisionId: UuidSchema,
    candidateDigest: ChecksumSchema,
    sceneId: UuidSchema,
    caseId: EmployeeMethodTestCaseIdSchema,
    retryOfTestId: UuidSchema.optional(),
  })
  .strict();
export const EmployeeMethodTestInspectSchema = z
  .object({ testId: UuidSchema })
  .strict();
export const EmployeeMethodAmountAssertionSchema = z
  .object({
    id: z.literal('integer-cny-total'),
    passed: z.boolean(),
    expected: z.literal(30000),
    actual: z.number().int().safe().nullable(),
    reason: z.enum([
      'matched',
      'amount_mismatch',
      'invalid_output',
      'execution_failed',
    ]),
  })
  .strict();
export const EmployeeMethodTestAssertionSchema = z.union([
  EmployeeMethodAmountAssertionSchema,
  EmployeeMethodFileAssertionSchema,
]);
export const EmployeeMethodTestSchema = z
  .object({
    sharedTarget: EmployeeMethodSharedTargetSchema.optional(),
    id: UuidSchema,
    instanceId: UuidSchema,
    setId: UuidSchema,
    candidateRevisionId: UuidSchema,
    candidateDigest: ChecksumSchema,
    dependencyDigest: ChecksumSchema,
    sceneId: UuidSchema,
    caseId: EmployeeMethodTestCaseIdSchema,
    environment: z.enum([
      employeeMethodTestEnvironment,
      employeeMethodFileCase.environment,
    ]),
    status: z.enum(['queued', 'running', 'succeeded', 'failed']),
    validationStatus: z.enum(['pending', 'passed', 'failed', 'not_verified']),
    applicable: z.boolean(),
    assertion: EmployeeMethodTestAssertionSchema.nullable(),
    runId: UuidSchema.nullable(),
    createdAt: TimestampSchema,
    completedAt: TimestampSchema.nullable(),
    errorCode: z.string().nullable(),
    retryOfTestId: UuidSchema.nullable(),
    retryTestId: UuidSchema.nullable(),
    files: z
      .array(
        z
          .object({
            stage: EmployeeMethodFileStageSchema,
            objectId: UuidSchema,
            versionId: UuidSchema,
            fileName: z.string(),
            checksum: ChecksumSchema,
            downloadUrl: z.string(),
            previewUrl: z.string(),
          })
          .strict(),
      )
      .default([]),
    currency: z.literal('CNY'),
    amountUnit: z.literal('cent'),
    coverage: z.enum([
      '仅验证所选场景在固定合成金额样例中的结果，不代表所有业务场景已验证。',
      employeeMethodFileCase.coverage,
    ]),
  })
  .strict();
export type EmployeeMethodTest = z.infer<typeof EmployeeMethodTestSchema>;

/** Immutable server-owned input and assertion. Never accept expected values,
 * pass/fail or a replacement assertion from the authoring model. */
export const employeeMethodAmountCase = {
  id: 'cny-total-v1' as const,
  prompt:
    '隔离测试样例：两笔人民币金额分别为 10000 分、20000 分。按所选工作场景的方法计算合计。只输出 JSON 对象 {"totalCents": 整数}，不加 Markdown 或说明。',
  evaluate(answer: string | null, executionFailed = false) {
    let actual: number | null = null;
    if (!executionFailed && answer && answer.length <= 1000) {
      try {
        const result = z
          .object({ totalCents: z.number().int().safe() })
          .strict()
          .parse(JSON.parse(answer));
        actual = result.totalCents;
      } catch {
        /* Missing or malformed results never become a pass. */
      }
    }
    return EmployeeMethodTestAssertionSchema.parse({
      id: 'integer-cny-total',
      expected: 30000,
      actual,
      passed: !executionFailed && actual === 30000,
      reason: executionFailed
        ? 'execution_failed'
        : actual === null
          ? 'invalid_output'
          : actual === 30000
            ? 'matched'
            : 'amount_mismatch',
    });
  },
};
