import type { OfficeFormulaResult, OfficeFormat } from '@allrice/contracts';
import {
  officeRenderNotice,
  renderOffice,
  officePreview,
} from '@allrice/office-runtime';
import {
  children,
  elements,
  ns,
  OfficePackage,
  officeError,
} from './package.js';

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
  if (byCell.size !== results.length) officeError('公式计算结果包含重复单元格');
  let matched = 0;
  for (const part of await pkg.orderedParts()) {
    const doc = await pkg.xml(part.path);
    for (const cell of elements(doc, ns.s, 'c')) {
      const formula = children(cell, ns.s, 'f')[0];
      if (!formula) continue;
      const result = byCell.get(
        JSON.stringify([part.name, cell.getAttribute('r')]),
      );
      if (
        !result ||
        (formula.getAttribute('t') &&
          !['normal', 'shared'].includes(formula.getAttribute('t')!)) ||
        result.formula !== (formula.textContent ?? '')
      )
        officeError('公式计算结果与源文件不一致');
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
  if (matched !== results.length) officeError('公式计算结果包含未知单元格');
  return matched ? pkg.finish() : bytes;
}

export async function checkOfficeExport(bytes: Buffer, format: OfficeFormat) {
  try {
    const rendered = await renderOffice(bytes, format);
    const checked =
      format === 'xlsx'
        ? await applyFormulaResults(bytes, rendered.formulas)
        : bytes;
    const preview = officePreview(rendered);
    const summary = {
      format: preview.format,
      pageCount: preview.pageCount,
      formulaCount: preview.formulaCount,
      formulaErrorCount: preview.formulaErrorCount,
      formulas: preview.formulas,
    };
    return {
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
    };
  } catch (error) {
    const reason = officeRenderNotice(error);
    return {
      bytes,
      quality: { status: 'unavailable' as const, reason },
      warnings: [reason],
    };
  }
}
