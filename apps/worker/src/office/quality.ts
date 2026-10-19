import type {
  OfficeFormulaResult,
  OfficeFormat,
  OfficeQualityDiagnostic,
} from '@allrice/contracts';
export type { OfficeQualityDiagnostic } from '@allrice/contracts';
import {
  officeRenderNotice,
  renderOffice,
  officePreview,
  OfficeRenderError,
} from '@allrice/office-runtime';
import { children, elements, ns, OfficePackage } from './package.js';
import { HandlerError } from '../errors.js';
import {
  inspectXlsxFormulaCaches,
  type XlsxFormulaCacheFacts,
} from './formula-cache.js';

type CachePatchCode =
  | 'duplicate_result'
  | 'result_missing'
  | 'unsupported_formula_range'
  | 'formula_mismatch'
  | 'unknown_result';
class CachePatchError extends HandlerError {
  constructor(
    readonly diagnosticCode: CachePatchCode,
    message: string,
  ) {
    super('OFFICE_DOCUMENT_INVALID', message, false);
  }
}
function cachePatchError(code: CachePatchCode, message: string): never {
  throw new CachePatchError(code, message);
}

/** Patch only cached values in the original ZIP; never replace a customer's
 * template with LibreOffice's rewritten workbook. Require complete coverage. */
export async function applyFormulaResults(
  bytes: Buffer,
  results: OfficeFormulaResult[],
) {
  const pkg = await OfficePackage.open(bytes, 'xlsx');
  const byCell = new Map(
    results.map((r) => [JSON.stringify([r.sheet, r.cell]), r]),
  );
  if (byCell.size !== results.length)
    cachePatchError('duplicate_result', '公式计算结果包含重复单元格');
  let matched = 0;
  for (const part of await pkg.orderedParts()) {
    const doc = await pkg.xml(part.path);
    for (const cell of elements(doc, ns.s, 'c')) {
      const formula = children(cell, ns.s, 'f')[0];
      if (!formula) continue;
      const result = byCell.get(
        JSON.stringify([part.name, cell.getAttribute('r')]),
      );
      if (!result)
        cachePatchError('result_missing', '公式计算结果与源文件不一致');
      if (
        formula.getAttribute('t') &&
        !['normal', 'shared'].includes(formula.getAttribute('t')!)
      )
        cachePatchError(
          'unsupported_formula_range',
          '公式计算结果与源文件不一致',
        );
      if (result.formula !== (formula.textContent ?? ''))
        cachePatchError('formula_mismatch', '公式计算结果与源文件不一致');
      for (const previous of [
        ...children(cell, ns.s, 'v'),
        ...children(cell, ns.s, 'is'),
      ])
        cell.removeChild(previous);
      cell.setAttribute('t', result.type);
      const value = doc.createElementNS(
        ns.s,
        cell.prefix ? `${cell.prefix}:v` : 'v',
      );
      value.textContent =
        result.type === 'b' ? (result.value ? '1' : '0') : String(result.value);
      cell.appendChild(value);
      pkg.changed.add(part.path);
      matched++;
    }
  }
  if (matched !== results.length)
    cachePatchError('unknown_result', '公式计算结果包含未知单元格');
  return matched ? pkg.finish() : bytes;
}

const rendererCodes = [
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
] as const;
type RenderCode = (typeof rendererCodes)[number];
function renderDiagnostic(error: unknown): OfficeQualityDiagnostic {
  if (error instanceof OfficeRenderError) {
    if (error.code === 'invalid_renderer_url')
      return { stage: 'local_policy', code: error.code };
    return {
      stage: 'renderer',
      code: rendererCodes.includes(error.code as RenderCode)
        ? (error.code as RenderCode)
        : 'render_failed',
    };
  }
  if (
    error instanceof Error &&
    ['TimeoutError', 'AbortError'].includes(error.name)
  )
    return { stage: 'transport', code: 'timeout' };
  // A bare TypeError can also be invalid local configuration. Only classify
  // transport when the runtime supplied a known socket/DNS cause; otherwise
  // retain the unknown render failure instead of inventing its original cause.
  if (
    error instanceof TypeError &&
    error.cause &&
    typeof error.cause === 'object' &&
    'code' in error.cause &&
    typeof error.cause.code === 'string' &&
    ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT'].includes(
      error.cause.code,
    )
  )
    return { stage: 'transport', code: 'transport_failed' };
  if (
    error instanceof SyntaxError ||
    (error instanceof Error && error.name === 'ZodError')
  )
    return { stage: 'renderer', code: 'protocol_invalid' };
  return { stage: 'renderer', code: 'render_failed' };
}
async function finalFacts<
  T extends {
    bytes: Buffer;
    warnings: string[];
    diagnostic?: OfficeQualityDiagnostic;
  },
>(
  result: T,
  format: OfficeFormat,
): Promise<
  T & {
    savedValues?: XlsxFormulaCacheFacts;
    diagnostic?: OfficeQualityDiagnostic;
  }
> {
  if (format !== 'xlsx') return result;
  const savedValues = await inspectXlsxFormulaCaches(result.bytes);
  const diagnostic =
    result.diagnostic ??
    (savedValues.inspection === 'incomplete'
      ? { stage: 'cache_inspection' as const, code: savedValues.code }
      : undefined);
  const warnings = [...result.warnings];
  if (savedValues.inspection === 'incomplete')
    warnings.push('最终 XLSX 保存值检查未完成，不能确认公式缓存完整。');
  else {
    const { missingCacheCount, invalidCacheCount, errorCacheCount } =
      savedValues.counts;
    if (missingCacheCount)
      warnings.push(
        `最终 XLSX 有 ${missingCacheCount} 个公式缺少已保存的结果。`,
      );
    if (invalidCacheCount)
      warnings.push(
        `最终 XLSX 有 ${invalidCacheCount} 个公式缓存的类型或内容无效。`,
      );
    if (errorCacheCount)
      warnings.push(`最终 XLSX 有 ${errorCacheCount} 个公式保存了错误结果。`);
  }
  return {
    ...result,
    savedValues,
    ...(diagnostic ? { diagnostic } : {}),
    warnings,
  };
}

export async function checkOfficeExport(
  bytes: Buffer,
  format: OfficeFormat,
  options: { cloudQualityAllowed?: boolean } = {},
) {
  if (options.cloudQualityAllowed === false)
    return finalFacts(
      {
        bytes,
        quality: {
          status: 'unavailable' as const,
          reason:
            '本地生成已验证；本地公式重算与页面预览尚未就绪，按任务的数据限制未外发到云端。',
        },
        diagnostic: {
          stage: 'local_policy',
          code: 'cloud_quality_disallowed',
        } as OfficeQualityDiagnostic,
        warnings: [
          '公式未重算、页面未渲染；生成通过不代表公式计算或排版已经检查。',
        ],
      },
      format,
    );
  let rendered;
  try {
    rendered = await renderOffice(bytes, format);
  } catch (error) {
    const reason = officeRenderNotice(error);
    return finalFacts(
      {
        bytes,
        quality: { status: 'unavailable' as const, reason },
        diagnostic: renderDiagnostic(error),
        warnings: [reason],
      },
      format,
    );
  }
  let checked = bytes;
  try {
    if (format === 'xlsx')
      checked = await applyFormulaResults(bytes, rendered.formulas);
  } catch (error) {
    const reason = officeRenderNotice(error);
    const diagnostic: OfficeQualityDiagnostic = {
      stage: 'cache_patch',
      code:
        error instanceof CachePatchError
          ? error.diagnosticCode
          : error instanceof HandlerError &&
              error.code === 'OFFICE_DOCUMENT_INVALID'
            ? 'invalid_package'
            : 'cache_patch_failed',
    };
    return finalFacts(
      {
        bytes,
        quality: { status: 'unavailable' as const, reason },
        diagnostic,
        warnings: [reason],
      },
      format,
    );
  }
  const preview = officePreview(rendered);
  const summary = {
    format: preview.format,
    pageCount: preview.pageCount,
    formulaCount: preview.formulaCount,
    formulaErrorCount: preview.formulaErrorCount,
    formulas: preview.formulas,
  };
  return finalFacts(
    {
      bytes: checked,
      quality: {
        status: 'checked' as const,
        ...summary,
        layout: 'rendered_not_visually_reviewed' as const,
      },
      warnings: [
        ...(summary.formulaErrorCount
          ? [`发现 ${summary.formulaErrorCount} 个公式错误，请修正后再次交付。`]
          : []),
        '已生成页面预览；转换成功不代表排版已人工检查，数值结果不代替业务对账。',
      ],
    },
    format,
  );
}
