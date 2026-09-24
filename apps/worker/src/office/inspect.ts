import {
  OfficePackage,
  children,
  elements,
  mainParts,
  ns,
  type OfficeFormat,
} from './package.js';
import type { ParsedDocument } from '../document-reader.js';

/** Addressable text from the original OOXML, without evaluating formulas or
 * using a lossy import/export cycle. A bounded view, never a replacement file. */
export async function inspectOffice(
  bytes: Buffer,
  format: OfficeFormat,
  maximumCharacters: number,
): Promise<ParsedDocument> {
  const pkg = await OfficePackage.open(bytes, format);
  const units: ParsedDocument['units'] = [];
  let remaining = maximumCharacters,
    truncated = false;
  const add = (label: string, text: string) => {
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    const available = Math.max(0, remaining - label.length - 8);
    units.push({ label, text: text.slice(0, available) });
    if (text.length > available) truncated = true;
    remaining -= label.length + 8 + Math.min(text.length, available);
  };
  if (format === 'docx') {
    const doc = await pkg.xml(mainParts.docx);
    for (const [index, p] of elements(doc, ns.w, 'p').entries()) {
      const text = elements(p, ns.w, 't')
        .map((t) => t.textContent)
        .join('');
      if (text) add(`正文段落 ${index + 1}`, text);
      if (remaining <= 0) {
        truncated = true;
        break;
      }
    }
  } else if (format === 'pptx') {
    for (const part of await pkg.orderedParts()) {
      const doc = await pkg.xml(part.path);
      add(
        `幻灯片 ${part.index}`,
        elements(doc, ns.a, 'p')
          .map((p) =>
            elements(p, ns.a, 't')
              .map((t) => t.textContent)
              .join(''),
          )
          .join('\n'),
      );
      if (remaining <= 0) {
        truncated = true;
        break;
      }
    }
  } else {
    // Follow the relationship rather than assuming sharedStrings.xml's path.
    const rels = await pkg.xml('xl/_rels/workbook.xml.rels');
    const sharedRel = elements(
      rels,
      'http://schemas.openxmlformats.org/package/2006/relationships',
      'Relationship',
    ).find((r) => r.getAttribute('Type')?.endsWith('/sharedStrings'));
    const sharedPath = sharedRel
      ? (await pkg.links(mainParts.xlsx)).get(sharedRel.getAttribute('Id')!)
      : undefined;
    const shared = sharedPath
      ? elements(await pkg.xml(sharedPath), ns.s, 'si').map((si) =>
          elements(si, ns.s, 't')
            .map((t) => t.textContent)
            .join(''),
        )
      : [];
    for (const part of await pkg.orderedParts()) {
      const doc = await pkg.xml(part.path);
      for (const cell of elements(doc, ns.s, 'c')) {
        const formula = children(cell, ns.s, 'f')[0],
          raw = children(cell, ns.s, 'v')[0]?.textContent ?? '';
        const type = cell.getAttribute('t');
        const value = formula
          ? `公式：=${formula.textContent || '[共享公式]'}${raw ? `；缓存（未重算）：${raw}` : '；未计算'}`
          : type === 's'
            ? (shared[Number(raw)] ?? '')
            : type === 'inlineStr'
              ? elements(cell, ns.s, 't')
                  .map((t) => t.textContent)
                  .join('')
              : type === 'b'
                ? String(raw === '1')
                : raw;
        add(`${part.name}!${cell.getAttribute('r')}`, value);
        if (remaining <= 0) {
          truncated = true;
          break;
        }
      }
      if (remaining <= 0) break;
    }
  }
  return {
    kind: format,
    units,
    text: units.map((unit) => `## ${unit.label}\n\n${unit.text}`).join('\n\n'),
    truncated,
    warnings: [
      ...(truncated
        ? ['内容已按 maxCharacters 截断；未返回的区域仍保留在源文件中。']
        : []),
      ...(format === 'xlsx'
        ? ['公式仅展示表达式与原有缓存，不代表已重算或核验。']
        : []),
    ],
  };
}
