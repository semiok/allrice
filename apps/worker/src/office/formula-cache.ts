import { createHash } from 'node:crypto';
import type { Element } from '@xmldom/xmldom';
import type { XlsxSavedValues } from '@allrice/contracts';
import { HandlerError } from '../errors.js';
import { children, ns, OfficePackage } from './package.js';

const limits = {
  worksheets: 256,
  cells: 100_000,
  formulas: 10_000,
  strings: 100_000,
};
/** Byte facts only: neither cache presence nor a render proves business correctness
 * or freshness. Incomplete inspections expose observed counts, never final totals. */
export type XlsxFormulaCacheFacts = XlsxSavedValues;
type InspectionCode = Extract<
  XlsxSavedValues,
  { inspection: 'incomplete' }
>['code'];
type Counts = Extract<XlsxSavedValues, { inspection: 'complete' }>['counts'];
class InspectionError extends Error {
  constructor(readonly code: InspectionCode) {
    super(code);
  }
}
function fail(code: InspectionCode): never {
  throw new InspectionError(code);
}
function plain(element: Element) {
  return !Array.from(element.childNodes).some((node) => node.nodeType === 1);
}
function address(value: string) {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(value);
  if (!match) return;
  const column = Array.from(match[1]!).reduce(
    (n, c) => n * 26 + c.charCodeAt(0) - 64,
    0,
  );
  const row = Number(match[2]);
  return column <= 16_384 && row <= 1_048_576 ? { column, row } : undefined;
}
function unsignedIndex(value: string) {
  const raw = value.trim(),
    number = Number(raw);
  return /^\+?\d+$/.test(raw) &&
    Number.isSafeInteger(number) &&
    number <= 4_294_967_295
    ? number
    : undefined;
}
function range(value: string) {
  const [first, last = first, extra] = value.split(':');
  const start = address(first ?? ''),
    end = address(last ?? '');
  return !extra &&
    start &&
    end &&
    start.column <= end.column &&
    start.row <= end.row
    ? { start, end }
    : undefined;
}
function stringItem(item: Element) {
  // CT_Rst permits an empty string. Exclude phonetic annotations from its value.
  return Array.from(item.childNodes).every((node) => {
    if (node.nodeType !== 1) return true;
    const child = node as Element;
    if (child.namespaceURI !== ns.s) return false;
    if (child.localName === 't') return plain(child);
    if (child.localName === 'r')
      return (
        children(child, ns.s, 't').length === 1 &&
        plain(children(child, ns.s, 't')[0]!)
      );
    return ['rPh', 'phoneticPr'].includes(child.localName ?? '');
  });
}

/** Inspect the final saved XLSX without rendering, calculating, or rewriting it.
 * Reuse the editor's ZIP, XML and workbook relationship bounds. */
export async function inspectXlsxFormulaCaches(
  bytes: Buffer,
): Promise<XlsxFormulaCacheFacts> {
  const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const counts: Counts = {
    formulaCount: 0,
    numericCacheCount: 0,
    booleanCacheCount: 0,
    stringCacheCount: 0,
    errorCacheCount: 0,
    missingCacheCount: 0,
    invalidCacheCount: 0,
    unsupportedCacheCount: 0,
    unsupportedFormulaCount: 0,
  };
  let incomplete: InspectionCode | undefined;
  const unknown = (code: InspectionCode) => {
    incomplete ??= code;
  };
  try {
    const pkg = await OfficePackage.open(bytes, 'xlsx');
    const parts = await pkg.orderedParts();
    if (!parts.length) fail('invalid_structure');
    if (parts.length > limits.worksheets) fail('limit_exceeded');
    if (
      new Set(parts.map((p) => p.name)).size !== parts.length ||
      new Set(parts.map((p) => p.path)).size !== parts.length
    )
      fail('ambiguous_cells');
    let sharedStrings: Element[] | undefined;
    const strings = async () => {
      if (sharedStrings) return sharedStrings;
      const rels = await pkg.xml('xl/_rels/workbook.xml.rels');
      const declarations = children(
        rels.documentElement!,
        'http://schemas.openxmlformats.org/package/2006/relationships',
        'Relationship',
      ).filter((rel) => rel.getAttribute('Type')?.endsWith('/sharedStrings'));
      if (
        declarations.length !== 1 ||
        declarations[0]!.getAttribute('TargetMode') === 'External'
      )
        fail('invalid_structure');
      const target = (await pkg.links('xl/workbook.xml')).get(
        declarations[0]!.getAttribute('Id') ?? '',
      );
      if (!target) fail('invalid_structure');
      const doc = await pkg.xml(target!);
      if (
        doc.documentElement?.namespaceURI !== ns.s ||
        doc.documentElement.localName !== 'sst'
      )
        fail('invalid_structure');
      sharedStrings = children(doc.documentElement, ns.s, 'si');
      if (sharedStrings.length > limits.strings) fail('limit_exceeded');
      return sharedStrings;
    };
    let cellCount = 0;
    for (const part of parts) {
      const doc = await pkg.xml(part.path),
        root = doc.documentElement;
      if (root?.namespaceURI !== ns.s || root.localName !== 'worksheet')
        fail('invalid_structure');
      const data = children(root, ns.s, 'sheetData');
      if (data.length !== 1) fail('invalid_structure');
      const seen = new Set<string>();
      const masters = new Map<string, NonNullable<ReturnType<typeof range>>>();
      const followers: {
        group: string;
        point: NonNullable<ReturnType<typeof address>>;
      }[] = [];
      for (const row of children(data[0]!, ns.s, 'row')) {
        for (const cell of children(row, ns.s, 'c')) {
          if (++cellCount > limits.cells) fail('limit_exceeded');
          const ref = cell.getAttribute('r') ?? '',
            point = address(ref);
          if (!point || seen.has(ref)) fail('ambiguous_cells');
          seen.add(ref);
          const formulas = children(cell, ns.s, 'f');
          if (!formulas.length) continue;
          if (formulas.length !== 1) fail('invalid_formula');
          if (counts.formulaCount >= limits.formulas) fail('limit_exceeded');
          counts.formulaCount++;
          const formula = formulas[0]!,
            kind = formula.hasAttribute('t')
              ? formula.getAttribute('t')!
              : 'normal';
          if (!plain(formula)) fail('invalid_formula');
          if ((formula.textContent?.length ?? 0) > 2000) fail('limit_exceeded');
          if (
            !['normal', 'shared'].includes(kind) ||
            cell.hasAttribute('cm') ||
            cell.hasAttribute('vm')
          ) {
            counts.unsupportedFormulaCount++;
            unknown('unsupported_formula');
          } else if (kind === 'shared') {
            const sharedIndex = unsignedIndex(formula.getAttribute('si') ?? '');
            if (sharedIndex === undefined) fail('invalid_formula');
            const group = String(sharedIndex);
            if (formula.textContent) {
              const coverage = range(formula.getAttribute('ref') ?? '');
              if (!coverage || masters.has(group)) fail('invalid_formula');
              masters.set(group, coverage);
            } else if (formula.hasAttribute('ref')) fail('invalid_formula');
            followers.push({ group, point: point! });
          } else if (!formula.textContent || formula.hasAttribute('ref'))
            fail('invalid_formula');
          const values = children(cell, ns.s, 'v'),
            inline = children(cell, ns.s, 'is');
          const type = cell.hasAttribute('t') ? cell.getAttribute('t')! : 'n';
          // Inline strings are literal cell storage, not a supported formula cache.
          if (
            type === 'inlineStr' ||
            !['n', 'b', 'str', 's', 'e'].includes(type)
          ) {
            counts.unsupportedCacheCount++;
            unknown('unsupported_cache_type');
            continue;
          }
          if (
            values.length > 1 ||
            inline.length ||
            (values[0] && !plain(values[0]))
          ) {
            counts.invalidCacheCount++;
            continue;
          }
          if (
            !values.length ||
            (type !== 'str' && !(values[0]!.textContent ?? '').trim())
          ) {
            counts.missingCacheCount++;
            continue;
          }
          const raw = values[0]!.textContent ?? '',
            value = raw.trim();
          if (type === 'n') {
            if (
              /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) &&
              Number.isFinite(Number(value))
            )
              counts.numericCacheCount++;
            else counts.invalidCacheCount++;
          } else if (type === 'b') {
            if (value === '0' || value === '1') counts.booleanCacheCount++;
            else counts.invalidCacheCount++;
          } else if (type === 's') {
            const index = unsignedIndex(value);
            if (index === undefined) {
              counts.invalidCacheCount++;
              continue;
            }
            const table = await strings();
            if (table[index] && stringItem(table[index]!))
              counts.stringCacheCount++;
            else counts.invalidCacheCount++;
          } else if (type === 'e') counts.errorCacheCount++;
          else counts.stringCacheCount++;
        }
      }
      for (const { group, point } of followers) {
        const coverage = masters.get(group);
        if (
          !coverage ||
          point.column < coverage.start.column ||
          point.column > coverage.end.column ||
          point.row < coverage.start.row ||
          point.row > coverage.end.row
        )
          fail('invalid_formula');
      }
    }
    return incomplete
      ? {
          checksum,
          inspection: 'incomplete',
          code: incomplete,
          observed: counts,
        }
      : { checksum, inspection: 'complete', counts };
  } catch (error) {
    return {
      checksum,
      inspection: 'incomplete',
      code:
        error instanceof InspectionError
          ? error.code
          : error instanceof HandlerError &&
              error.code === 'OFFICE_DOCUMENT_INVALID'
            ? 'invalid_package'
            : 'inspection_failed',
      observed: counts,
    };
  }
}
