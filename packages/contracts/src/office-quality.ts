import { z } from 'zod';

export const OfficeFormatSchema = z.enum(['docx', 'xlsx', 'pptx']);
const address = {
  sheet: z.string().min(1).max(31),
  cell: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}$/),
  formula: z.string().max(2000),
};
export const OfficeFormulaResultSchema = z.discriminatedUnion('type', [
  z
    .object({ ...address, type: z.literal('n'), value: z.number().finite() })
    .strict(),
  z.object({ ...address, type: z.literal('b'), value: z.boolean() }).strict(),
  z
    .object({
      ...address,
      type: z.enum(['str', 'e']),
      value: z.string().max(20_000),
    })
    .strict(),
]);
const page = z
  .object({
    number: z.number().int().min(1).max(100_000),
    base64: z
      .string()
      .min(1)
      .max(4_000_000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export const OfficeRenderResponseSchema = z
  .object({
    checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    format: OfficeFormatSchema,
    engine: z.string().min(1).max(120),
    pageCount: z.number().int().min(1).max(100_000),
    pages: z.array(page).min(1).max(8),
    formulas: z.array(OfficeFormulaResultSchema).max(10_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.pages.reduce((n, p) => n + p.base64.length, 0) > 4_000_016 ||
      value.pages.some(
        (p, i) => p.number !== i + 1 || p.number > value.pageCount,
      ) ||
      (value.format !== 'xlsx' && value.formulas.length)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Office render limits exceeded',
      });
  });
export const OfficePreviewSchema = z
  .object({
    kind: z.literal('office'),
    checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    format: OfficeFormatSchema,
    pageCount: z.number().int().min(1).max(100_000),
    pages: z.array(page).min(1).max(8),
    formulaCount: z.number().int().min(0).max(10_000),
    formulaErrorCount: z.number().int().min(0).max(10_000),
    formulas: z.array(OfficeFormulaResultSchema).max(50),
  })
  .strict();
export type OfficeFormat = z.infer<typeof OfficeFormatSchema>;
export type OfficeFormulaResult = z.infer<typeof OfficeFormulaResultSchema>;
export type OfficeRenderResponse = z.infer<typeof OfficeRenderResponseSchema>;
export type OfficePreview = z.infer<typeof OfficePreviewSchema>;
