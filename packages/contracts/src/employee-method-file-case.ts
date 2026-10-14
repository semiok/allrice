import { z } from 'zod';
import { cloudToolchainImageV1 } from './runtime-v2/cloud-command.ts';

export const EmployeeMethodFileStageSchema = z.enum(['normalize', 'summarize']);
export type EmployeeMethodFileStage = z.infer<
  typeof EmployeeMethodFileStageSchema
>;

/** Private test-tool input. Identity, files, runtime and limits are selected by
 * the trusted test runner, never by the authoring or test model. */
export const EmployeeMethodFileStepSchema = z
  .object({
    stage: EmployeeMethodFileStageSchema,
    script: z
      .string()
      .min(1)
      .max(20_000)
      .refine((s) => !s.includes('\0')),
  })
  .strict();

/** Versioned platform-owned sample. Freeze this complete value into the test
 * binding; changing the sample or environment requires a new case version. */
export const employeeMethodFileCase = {
  id: 'cny-file-flow-v1',
  environment: 'isolated-file-flow-v1',
  input: {
    path: 'amounts.csv',
    mediaType: 'text/csv',
    text: 'entryId,amountCents\none,10000\ntwo,20000\n',
  },
  stages: ['normalize', 'summarize'],
  outputs: {
    normalize: {
      path: 'normalized.json',
      fileName: 'normalized.json',
      format: 'json',
    },
    summarize: {
      path: 'summary.csv',
      fileName: 'summary.csv',
      format: 'csv',
    },
  },
  runtime: {
    backend: 'cloud-gvisor-v1',
    imageDigest: cloudToolchainImageV1,
    runtime: 'runsc',
    network: 'none',
    language: 'javascript',
    limits: {
      timeoutMs: 30_000,
      outputBytes: 8_192,
      artifactBytes: 32_768,
      memoryMiB: 256,
      cpuMillis: 500,
      pids: 64,
    },
  },
  assertion: { id: 'file-flow-cny-total', expected: 30000 },
  prompt:
    '隔离测试：按所选候选工作场景处理 amounts.csv，最终交付 summary.csv。' +
    '原始文件含 entryId、amountCents 两列，金额单位为人民币整数分。' +
    '可用的 platform_employee_method_step 工具执行候选指定的步骤；文件由平台提供并收集。' +
    '这是验证候选实际行为，不是修改候选：不要自行纠正其步骤或口径。' +
    '若无法按候选执行，说明原因。最终聊天文本不能代替真实文件。',
  coverage:
    '仅验证固定合成 CSV 样例的两步执行顺序、文件传递及金额结果，不代表任意业务文件、流程或所有场景已验证。',
} as const;

export const EmployeeMethodFileAssertionSchema = z
  .object({
    id: z.literal('file-flow-cny-total'),
    passed: z.boolean(),
    expected: z.literal(30000),
    actual: z.number().int().safe().nullable(),
    reason: z.enum([
      'matched',
      'amount_mismatch',
      'invalid_output',
      'wrong_stage',
      'missing_stage',
      'execution_failed',
    ]),
  })
  .strict();

/** This checks collected file bytes, not the model's claim about its output. */
export function evaluateEmployeeMethodFileOutput(
  stage: EmployeeMethodFileStage,
  text: string,
) {
  let actual: number | null = null;
  if (text.length <= 32_768) {
    try {
      if (stage === 'normalize') {
        const result = z
          .object({
            currency: z.literal('CNY'),
            amountUnit: z.literal('cent'),
            rows: z.tuple([
              z
                .object({
                  entryId: z.literal('one'),
                  amountCents: z.number().int().safe(),
                })
                .strict(),
              z
                .object({
                  entryId: z.literal('two'),
                  amountCents: z.number().int().safe(),
                })
                .strict(),
            ]),
          })
          .strict()
          .parse(JSON.parse(text));
        const sum = result.rows[0].amountCents + result.rows[1].amountCents;
        if (Number.isSafeInteger(sum)) actual = sum;
        if (
          actual === 30000 &&
          (result.rows[0].amountCents !== 10000 ||
            result.rows[1].amountCents !== 20000)
        )
          return { passed: false, actual, reason: 'invalid_output' as const };
      } else {
        const lines = text.replaceAll('\r\n', '\n').trimEnd().split('\n');
        if (
          lines.length === 2 &&
          lines[0] === 'currency,amountUnit,totalCents'
        ) {
          const fields = lines[1]!.split(',');
          if (
            fields.length === 3 &&
            fields[0] === 'CNY' &&
            fields[1] === 'cent' &&
            /^-?\d+$/.test(fields[2]!) &&
            Number.isSafeInteger(Number(fields[2]))
          )
            actual = Number(fields[2]);
        }
      }
    } catch {
      // Malformed or extra fields are not evidence of correct delivery.
    }
  }
  return {
    passed: actual === 30000,
    actual,
    reason:
      actual === null
        ? ('invalid_output' as const)
        : actual === 30000
          ? ('matched' as const)
          : ('amount_mismatch' as const),
  };
}
