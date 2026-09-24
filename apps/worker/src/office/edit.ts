import type { Element } from '@xmldom/xmldom';
import type { OfficeEdit, OfficeCell } from '@allrice/contracts';
import {
  OfficePackage,
  children,
  elements,
  mainParts,
  ns,
  officeError,
  type OfficeFormat,
} from './package.js';

function paragraphTextNodes(paragraph: Element, uri: string) {
  return elements(paragraph, uri, 't').filter((node) => {
    let ancestor = node.parentNode;
    while (ancestor && ancestor !== paragraph) {
      if (
        ancestor.nodeType === 1 &&
        (ancestor as Element).localName === 'p' &&
        (ancestor as Element).namespaceURI === uri
      )
        return false;
      // Deleted text is not the visible document and must not enter matching.
      if (
        ancestor.nodeType === 1 &&
        (ancestor as Element).localName === 'del' &&
        (ancestor as Element).namespaceURI === ns.w
      )
        return false;
      ancestor = ancestor.parentNode;
    }
    return true;
  });
}

// Replace only characters belonging to the match. Text before/after it remains
// in its original run and retains its style; inserted text uses the first run.
function replaceInParagraph(
  paragraph: Element,
  uri: string,
  find: string,
  replace: string,
) {
  const nodes = paragraphTextNodes(paragraph, uri);
  const texts = nodes.map((node) => node.textContent ?? '');
  const joined = texts.join(''),
    offsets: number[] = [];
  let position = 0;
  for (;;) {
    const next = joined.indexOf(find, position);
    if (next < 0) break;
    offsets.push(next);
    position = next + find.length;
  }
  if (!offsets.length) return 0;
  if (
    uri === ns.w &&
    (elements(paragraph, ns.w, 'fldChar').length ||
      elements(paragraph, ns.w, 'fldSimple').length)
  )
    officeError('匹配文字位于 Word 域中，请修改普通正文或模板占位文字');
  let start = 0;
  const ranges = texts.map((text) => {
    const range = { start, end: start + text.length };
    start += text.length;
    return range;
  });
  for (const offset of offsets.reverse()) {
    const end = offset + find.length;
    for (let i = 0; i < nodes.length; i++) {
      const range = ranges[i]!;
      if (range.end <= offset || range.start >= end) continue;
      const first = offset >= range.start;
      const text = nodes[i]!.textContent ?? '';
      nodes[i]!.textContent =
        text.slice(0, Math.max(0, offset - range.start)) +
        (first ? replace : '') +
        text.slice(Math.max(0, end - range.start));
      nodes[i]!.setAttributeNS(
        'http://www.w3.org/XML/1998/namespace',
        'xml:space',
        'preserve',
      );
    }
  }
  return offsets.length;
}

function coordinate(cell: string) {
  const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(cell);
  if (!match) officeError('单元格地址无效');
  const column = [...match[1]!].reduce(
    (value, character) => value * 26 + character.charCodeAt(0) - 64,
    0,
  );
  const row = Number(match[2]);
  if (column > 16384 || row > 1048576) officeError('单元格地址超出 Excel 范围');
  return { column, row };
}
function setCell(sheet: Element, address: string, value: OfficeCell) {
  const { row: rowNumber, column } = coordinate(address),
    doc = sheet.ownerDocument!;
  const data = children(sheet, ns.s, 'sheetData')[0];
  if (!data) officeError('工作表缺少 sheetData');
  for (const merge of elements(sheet, ns.s, 'mergeCell')) {
    const [first, last = first] = (merge.getAttribute('ref') ?? '').split(':');
    if (!first || !last) continue;
    const a = coordinate(first),
      b = coordinate(last);
    if (
      rowNumber >= a.row &&
      rowNumber <= b.row &&
      column >= a.column &&
      column <= b.column &&
      address !== first
    )
      officeError('合并单元格只能修改左上角单元格');
  }
  for (const f of elements(sheet, ns.s, 'f')) {
    if (f.getAttribute('t') !== 'array') continue;
    const [first, last = first] = (f.getAttribute('ref') ?? '').split(':');
    if (!first || !last) continue;
    const a = coordinate(first),
      b = coordinate(last);
    if (
      rowNumber >= a.row &&
      rowNumber <= b.row &&
      column >= a.column &&
      column <= b.column
    )
      officeError('数组公式范围不能局部改写');
  }
  let row = children(data, ns.s, 'row').find(
    (r) => r.getAttribute('r') === String(rowNumber),
  );
  if (!row) {
    row = doc.createElementNS(ns.s, 'row');
    row.setAttribute('r', String(rowNumber));
    data.insertBefore(
      row,
      children(data, ns.s, 'row').find(
        (r) => Number(r.getAttribute('r')) > rowNumber,
      ) ?? null,
    );
  }
  let cell = children(row, ns.s, 'c').find(
    (c) => c.getAttribute('r') === address,
  );
  if (!cell) {
    cell = doc.createElementNS(ns.s, 'c');
    cell.setAttribute('r', address);
    row.insertBefore(
      cell,
      children(row, ns.s, 'c').find(
        (c) => coordinate(c.getAttribute('r')!).column > column,
      ) ??
        children(row, ns.s, 'extLst')[0] ??
        null,
    );
  }
  row.removeAttribute('spans');
  const formula = children(cell, ns.s, 'f')[0];
  if (formula?.hasAttribute('t') && formula.getAttribute('t') !== 'normal')
    officeError('共享或数组公式不能局部改写，请修改普通输入单元格');
  for (const node of Array.from(cell.childNodes)) {
    if (
      node.nodeType === 1 &&
      ['v', 'f', 'is'].includes((node as Element).localName!)
    )
      cell.removeChild(node);
  }
  cell.removeAttribute('t');
  const append = (name: string, text: string) => {
    const e = doc.createElementNS(ns.s, name);
    e.textContent = text;
    cell!.insertBefore(e, children(cell!, ns.s, 'extLst')[0] ?? null);
    return e;
  };
  if (typeof value === 'string') {
    cell.setAttribute('t', 'inlineStr');
    const inline = append('is', ''),
      text = doc.createElementNS(ns.s, 't');
    text.setAttributeNS(
      'http://www.w3.org/XML/1998/namespace',
      'xml:space',
      'preserve',
    );
    text.textContent = value;
    inline.appendChild(text);
  } else if (typeof value === 'number') append('v', String(value));
  else if (typeof value === 'boolean') {
    cell.setAttribute('t', 'b');
    append('v', value ? '1' : '0');
  } else if (value !== null) append('f', value.formula.replace(/^=/, ''));
  // Omit the optional cached extent rather than retaining an inaccurate range.
  for (const dimension of children(sheet, ns.s, 'dimension'))
    sheet.removeChild(dimension);
}

async function invalidateCalculation(pkg: OfficePackage) {
  for (const part of await pkg.orderedParts()) {
    const doc = await pkg.xml(part.path);
    const arrayRanges = elements(doc, ns.s, 'f')
      .filter((f) => f.getAttribute('t') === 'array' && f.hasAttribute('ref'))
      .map((f) => {
        const [start, end = start] = f.getAttribute('ref')!.split(':');
        return { start: coordinate(start!), end: coordinate(end!) };
      });
    for (const cell of elements(doc, ns.s, 'c')) {
      const point = coordinate(cell.getAttribute('r') ?? '');
      // Array/spill result cells can have a cache without their own <f>.
      const arrayResult = arrayRanges.some(
        ({ start, end }) =>
          point.row >= start.row &&
          point.row <= end.row &&
          point.column >= start.column &&
          point.column <= end.column,
      );
      if (!children(cell, ns.s, 'f').length && !arrayResult) continue;
      for (const cached of children(cell, ns.s, 'v')) cell.removeChild(cached);
      // The previous result type is a cache too (e.g. bool/error/string).
      cell.removeAttribute('t');
      pkg.changed.add(part.path);
    }
  }
  const workbook = await pkg.xml(mainParts.xlsx),
    root = workbook.documentElement!;
  let calc = children(root, ns.s, 'calcPr')[0];
  if (!calc) {
    calc = workbook.createElementNS(ns.s, 'calcPr');
    const following = new Set([
      'oleSize',
      'customWorkbookViews',
      'pivotCaches',
      'smartTagPr',
      'smartTagTypes',
      'webPublishing',
      'fileRecoveryPr',
      'webPublishObjects',
      'extLst',
    ]);
    const next = Array.from(root.childNodes).find(
      (node) =>
        node.nodeType === 1 &&
        (node as Element).namespaceURI === ns.s &&
        following.has((node as Element).localName!),
    );
    root.insertBefore(calc, next ?? null);
  }
  calc.setAttribute('calcMode', 'auto');
  calc.setAttribute('fullCalcOnLoad', '1');
  calc.setAttribute('forceFullCalc', '1');
  pkg.changed.add(mainParts.xlsx);
  const relPath = 'xl/_rels/workbook.xml.rels',
    rels = await pkg.xml(relPath);
  for (const rel of elements(
    rels,
    'http://schemas.openxmlformats.org/package/2006/relationships',
    'Relationship',
  )) {
    if (!rel.getAttribute('Type')?.endsWith('/calcChain')) continue;
    const links = await pkg.links(mainParts.xlsx),
      path = links.get(rel.getAttribute('Id')!);
    if (path) {
      pkg.zip.remove(path);
      const types = await pkg.xml('[Content_Types].xml');
      for (const type of elements(
        types,
        'http://schemas.openxmlformats.org/package/2006/content-types',
        'Override',
      ))
        if (type.getAttribute('PartName') === `/${path}`)
          type.parentNode!.removeChild(type);
      pkg.changed.add('[Content_Types].xml');
    }
    rel.parentNode!.removeChild(rel);
    pkg.changed.add(relPath);
  }
}

export async function editOffice(
  bytes: Buffer,
  format: OfficeFormat,
  edit: OfficeEdit,
) {
  const pkg = await OfficePackage.open(bytes, format);
  const changed: {
    type: string;
    matches?: number;
    sheet?: string;
    cell?: string;
  }[] = [];
  for (const change of edit.changes) {
    if (change.type === 'set-cell') {
      if (format !== 'xlsx') officeError('set-cell 仅用于 XLSX');
      const part = (await pkg.orderedParts()).find(
        (p) => p.name === change.sheet,
      );
      if (!part) officeError(`未找到工作表：${change.sheet}`);
      const doc = await pkg.xml(part.path);
      setCell(doc.documentElement!, change.cell, change.value);
      pkg.changed.add(part.path);
      changed.push({
        type: change.type,
        sheet: change.sheet,
        cell: change.cell,
      });
    } else {
      if (format === 'xlsx') officeError('XLSX 请按工作表和单元格修改');
      if (format === 'docx' && change.slide !== undefined)
        officeError('Word 修改不能指定幻灯片');
      const parts =
        format === 'docx'
          ? [{ path: mainParts.docx, index: 1 }]
          : await pkg.orderedParts();
      let matches = 0;
      for (const part of parts) {
        if (change.slide !== undefined && change.slide !== part.index) continue;
        const doc = await pkg.xml(part.path),
          uri = format === 'docx' ? ns.w : ns.a;
        let count = 0;
        for (const paragraph of elements(doc, uri, 'p'))
          count += replaceInParagraph(
            paragraph,
            uri,
            change.find,
            change.replace,
          );
        if (count) pkg.changed.add(part.path);
        matches += count;
      }
      if (matches !== change.expectedOccurrences)
        officeError(
          `文字匹配 ${matches} 处，预期 ${change.expectedOccurrences} 处；未交付修改文件，请核对原文和范围`,
        );
      changed.push({ type: change.type, matches });
    }
  }
  if (format === 'xlsx') await invalidateCalculation(pkg);
  const changedParts = [...pkg.changed];
  return {
    bytes: await pkg.finish(),
    changes: changed,
    changedParts,
    warnings:
      format === 'xlsx'
        ? [
            '公式表达式已保留或按要求修改；缓存已清除，需在 Excel/LibreOffice 打开后重新计算。此步骤未验证公式结果。',
          ]
        : ['已保留未修改的包成员；此步骤未进行渲染排版检查。'],
  };
}
