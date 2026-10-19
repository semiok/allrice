import { z } from 'zod';

export const officeMediaTypes = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;

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

const savedValueCounts = z
  .object({
    formulaCount: z.number().int().min(0).max(10_000),
    numericCacheCount: z.number().int().min(0).max(10_000),
    booleanCacheCount: z.number().int().min(0).max(10_000),
    stringCacheCount: z.number().int().min(0).max(10_000),
    errorCacheCount: z.number().int().min(0).max(10_000),
    missingCacheCount: z.number().int().min(0).max(10_000),
    invalidCacheCount: z.number().int().min(0).max(10_000),
    unsupportedCacheCount: z.number().int().min(0).max(10_000),
    unsupportedFormulaCount: z.number().int().min(0).max(10_000),
  })
  .strict();
export const XlsxSavedValueInspectionCodeSchema = z.enum([
  'invalid_package',
  'invalid_structure',
  'ambiguous_cells',
  'invalid_formula',
  'unsupported_formula',
  'unsupported_cache_type',
  'limit_exceeded',
  'inspection_failed',
]);
/** Final saved byte facts; cache presence does not prove freshness or correctness. */
export const XlsxSavedValuesSchema = z
  .discriminatedUnion('inspection', [
    z
      .object({
        checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        inspection: z.literal('complete'),
        counts: savedValueCounts,
      })
      .strict(),
    z
      .object({
        checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        inspection: z.literal('incomplete'),
        code: XlsxSavedValueInspectionCodeSchema,
        observed: savedValueCounts,
      })
      .strict(),
  ])
  .superRefine((facts, ctx) => {
    const counts =
      facts.inspection === 'complete' ? facts.counts : facts.observed;
    const classified =
      counts.numericCacheCount +
      counts.booleanCacheCount +
      counts.stringCacheCount +
      counts.errorCacheCount +
      counts.missingCacheCount +
      counts.invalidCacheCount +
      counts.unsupportedCacheCount;
    if (
      classified > counts.formulaCount ||
      counts.unsupportedFormulaCount > counts.formulaCount ||
      (facts.inspection === 'complete' &&
        (classified !== counts.formulaCount ||
          counts.unsupportedCacheCount !== 0 ||
          counts.unsupportedFormulaCount !== 0))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Inconsistent saved value counts',
      });
  });
export type XlsxSavedValues = z.infer<typeof XlsxSavedValuesSchema>;

/** A finite execution stage/code, never a raw renderer exception or stderr. */
export const OfficeQualityDiagnosticSchema = z.discriminatedUnion('stage', [
  z
    .object({
      stage: z.literal('local_policy'),
      code: z.enum(['cloud_quality_disallowed', 'invalid_renderer_url']),
    })
    .strict(),
  z
    .object({
      stage: z.literal('transport'),
      code: z.enum(['timeout', 'transport_failed']),
    })
    .strict(),
  z
    .object({
      stage: z.literal('renderer'),
      code: z.enum([
        'file_too_large',
        'empty_response',
        'response_too_large',
        'content_changed',
        'invalid_preview_image',
        'unsupported_formula_range',
        'too_many_formulas',
        'external_content',
        'active_content',
        'renderer_busy',
        'request_too_large',
        'conversion_timeout',
        'conversion_failed',
        'invalid_office_file',
        'not_found',
        'protocol_invalid',
        'render_failed',
      ]),
    })
    .strict(),
  z
    .object({
      stage: z.literal('cache_patch'),
      code: z.enum([
        'duplicate_result',
        'result_missing',
        'unsupported_formula_range',
        'formula_mismatch',
        'unknown_result',
        'invalid_package',
        'cache_patch_failed',
      ]),
    })
    .strict(),
  z
    .object({
      stage: z.literal('cache_inspection'),
      code: XlsxSavedValueInspectionCodeSchema,
    })
    .strict(),
]);
export type OfficeQualityDiagnostic = z.infer<
  typeof OfficeQualityDiagnosticSchema
>;

/** A typed projection of the actual exporter receipt, never model prose. */
export const OfficeDeliveryReceiptSchema = z
  .object({
    quality: z.discriminatedUnion('status', [
      z.object({
        status: z.literal('checked'),
        format: z.enum(['docx', 'xlsx', 'pptx']),
        pageCount: z.number().int().positive(),
        formulaCount: z.number().int().nonnegative(),
        formulaErrorCount: z.number().int().nonnegative(),
        layout: z.literal('rendered_not_visually_reviewed'),
      }),
      z.object({
        status: z.literal('unavailable'),
        reason: z.string().max(4000),
      }),
    ]),
    warnings: z.array(z.string().max(4000)).max(50),
    // Optional with no defaults: old receipts remain uninspected/unknown.
    savedValues: XlsxSavedValuesSchema.optional(),
    diagnostic: OfficeQualityDiagnosticSchema.optional(),
  })
  .superRefine((receipt, ctx) => {
    if (
      receipt.savedValues &&
      receipt.quality.status === 'checked' &&
      receipt.quality.format !== 'xlsx'
    )
      ctx.addIssue({ code: 'custom', message: 'Saved values require XLSX' });
  });
export type OfficeDeliveryReceipt = z.infer<typeof OfficeDeliveryReceiptSchema>;

/** A server-frozen technical standard, never an expected-output DSL or tool flag. */
export const OfficeFirstDeliveryPolicySchema = z.literal(
  'xlsx_formula_cache_v1',
);
export type OfficeFirstDeliveryPolicy = z.infer<
  typeof OfficeFirstDeliveryPolicySchema
>;

/** Internal publisher stamp, separate from success/failure of quality inspection. */
export const OfficeExportProducerSchema = z
  .object({
    version: z.literal(1),
    tool: z.literal('workspace.export.create'),
    callId: z.string().min(1).max(255),
    objectId: z.uuid(),
  })
  .strict();
export type OfficeExportProducer = z.infer<typeof OfficeExportProducerSchema>;

export interface OfficeFormulaCacheAssessment {
  status: 'satisfied' | 'incomplete' | 'not_applicable';
  hasFormulas: boolean;
  reason:
    | 'cache_present'
    | 'no_formulas'
    | 'receipt_unavailable'
    | 'inspection_incomplete'
    | 'formula_output_missing'
    | 'formula_count_mismatch'
    | 'missing_cache'
    | 'invalid_cache'
    | 'formula_error';
}

/** Only consume an exact-object-bound receipt. This proves no business values,
 * freshness, recalculation requirement, formula preservation or visual quality. */
export function assessOfficeFormulaCaches(
  value: unknown,
  requireFormulas = false,
): OfficeFormulaCacheAssessment {
  const parsed = OfficeDeliveryReceiptSchema.safeParse(value);
  if (!parsed.success)
    return {
      status: 'incomplete',
      hasFormulas: false,
      reason: 'receipt_unavailable',
    };
  const receipt = parsed.data;
  const checked =
    receipt.quality.status === 'checked' && receipt.quality.format === 'xlsx'
      ? receipt.quality
      : undefined;
  const saved = receipt.savedValues;
  const counts =
    saved?.inspection === 'complete' ? saved.counts : saved?.observed;
  const hasFormulas =
    (counts?.formulaCount ?? 0) > 0 || (checked?.formulaCount ?? 0) > 0;
  const incomplete = (
    reason: OfficeFormulaCacheAssessment['reason'],
  ): OfficeFormulaCacheAssessment => ({
    status: 'incomplete',
    hasFormulas,
    reason,
  });
  if (!saved) return incomplete('receipt_unavailable');
  if (saved.inspection !== 'complete')
    return incomplete('inspection_incomplete');
  if (checked && checked.formulaCount !== saved.counts.formulaCount)
    return incomplete('formula_count_mismatch');
  if (saved.counts.errorCacheCount || checked?.formulaErrorCount)
    return incomplete('formula_error');
  if (saved.counts.invalidCacheCount) return incomplete('invalid_cache');
  if (saved.counts.missingCacheCount) return incomplete('missing_cache');
  if (!saved.counts.formulaCount)
    return requireFormulas
      ? incomplete('formula_output_missing')
      : { status: 'not_applicable', hasFormulas: false, reason: 'no_formulas' };
  return { status: 'satisfied', hasFormulas: true, reason: 'cache_present' };
}
