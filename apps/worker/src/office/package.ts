import posix from 'node:path/posix';
import { Readable } from 'node:stream';
import JSZip from 'jszip';
import {
  DOMParser,
  XMLSerializer,
  type Document,
  type Element,
} from '@xmldom/xmldom';
import { HandlerError } from '../errors.js';

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx';
export { officeMediaTypes } from '@allrice/contracts';
export const ns = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  s: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
};
export const mainParts = {
  docx: 'word/document.xml',
  xlsx: 'xl/workbook.xml',
  pptx: 'ppt/presentation.xml',
} as const;
export function officeError(message: string): never {
  throw new HandlerError('OFFICE_DOCUMENT_INVALID', message, false);
}

// JSZip normalizes names and overwrites duplicate entries. Check the original
// central directory before loading so an edit cannot silently change the package.
function checkZip(bytes: Buffer) {
  if (bytes.length > 20 * 1024 * 1024) officeError('Office 文件超过 20 MB');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) officeError('Office ZIP 目录无效');
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16),
    expanded = 0;
  const size = bytes.readUInt32LE(end + 12);
  if (
    !count ||
    count > 4096 ||
    bytes.readUInt32LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 8) !== count ||
    offset + size !== end
  )
    officeError('不支持此 Office ZIP 目录或分卷格式');
  const names = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
      officeError('Office ZIP 成员无效');
    const flags = bytes.readUInt16LE(offset + 8),
      method = bytes.readUInt16LE(offset + 10);
    const length = bytes.readUInt32LE(offset + 24),
      nameLength = bytes.readUInt16LE(offset + 28);
    const next =
      offset +
      46 +
      nameLength +
      bytes.readUInt16LE(offset + 30) +
      bytes.readUInt16LE(offset + 32);
    if (
      next > end ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      length > 32 * 1024 * 1024
    )
      officeError('不支持加密、ZIP64 或过大 Office 成员');
    const name = bytes
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString('utf8');
    if (
      !name ||
      name.includes('\0') ||
      /[\uFFFD\\]/.test(name) ||
      name.startsWith('/') ||
      name.split('/').some((p) => p === '..' || p === '.') ||
      names.has(name)
    )
      officeError('Office ZIP 包含重复或无效路径');
    names.add(name);
    expanded += length;
    if (expanded > 64 * 1024 * 1024) officeError('Office 解压内容超过 64 MB');
    offset = next;
  }
  if (offset !== end) officeError('Office ZIP 目录长度不符');
}

export function elements(
  root: Document | Element,
  uri: string,
  name: string,
): Element[] {
  return Array.from(root.getElementsByTagNameNS(uri, name));
}
export function children(root: Element, uri: string, name: string): Element[] {
  return Array.from(root.childNodes).filter(
    (node): node is Element =>
      node.nodeType === 1 &&
      (node as Element).namespaceURI === uri &&
      (node as Element).localName === name,
  );
}

export class OfficePackage {
  readonly documents = new Map<string, Document>();
  readonly changed = new Set<string>();
  private constructor(
    readonly zip: JSZip,
    readonly format: OfficeFormat,
  ) {}
  static async open(bytes: Buffer, format: OfficeFormat) {
    checkZip(bytes);
    const zip = await JSZip.loadAsync(bytes);
    if (
      Object.keys(zip.files).some((p) =>
        /(?:vbaProject\.bin|^_xmlsignatures\/)/i.test(p),
      )
    )
      officeError('此文件含宏或数字签名，不能按普通 Office 文档修改');
    const pkg = new OfficePackage(zip, format);
    const types = await pkg.xml('[Content_Types].xml');
    const main = mainParts[format];
    const suffix = {
      docx: 'wordprocessingml.document.main+xml',
      xlsx: 'spreadsheetml.sheet.main+xml',
      pptx: 'presentationml.presentation.main+xml',
    }[format];
    const declaration = elements(
      types,
      'http://schemas.openxmlformats.org/package/2006/content-types',
      'Override',
    ).find((e) => e.getAttribute('PartName') === `/${main}`);
    if (!declaration?.getAttribute('ContentType')?.endsWith(suffix))
      officeError('Office 格式与包内容不一致');
    const doc = await pkg.xml(main);
    const expected = format === 'docx' ? ns.w : format === 'xlsx' ? ns.s : ns.p;
    if (doc.documentElement?.namespaceURI !== expected)
      officeError('当前编辑支持常规 OOXML；此命名空间暂不支持');
    return pkg;
  }
  async xml(path: string) {
    const cached = this.documents.get(path);
    if (cached) return cached;
    const entry = this.zip.file(path);
    if (!entry) officeError(`Office 文件缺少 ${path}`);
    const stream = new Readable().wrap(entry.nodeStream());
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const value of stream) {
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        stream.destroy();
        officeError('Office XML 超过 8 MB');
      }
      chunks.push(chunk);
    }
    const xml = Buffer.concat(chunks).toString('utf8');
    if (/<!DOCTYPE|<!ENTITY/i.test(xml))
      officeError('Office XML 不支持 DTD 或实体声明');
    const doc = new DOMParser({
      onError: () => officeError(`Office XML 无效：${path}`),
    }).parseFromString(xml, 'application/xml');
    this.documents.set(path, doc);
    return doc;
  }
  async links(part: string) {
    const path = posix.join(
      posix.dirname(part),
      '_rels',
      `${posix.basename(part)}.rels`,
    );
    const doc = await this.xml(path);
    const links = new Map<string, string>();
    for (const rel of elements(
      doc,
      'http://schemas.openxmlformats.org/package/2006/relationships',
      'Relationship',
    )) {
      if (rel.getAttribute('TargetMode') === 'External') continue;
      const raw = rel.getAttribute('Target') ?? '';
      const target = posix.normalize(
        raw.startsWith('/')
          ? raw.slice(1)
          : posix.join(posix.dirname(part), raw),
      );
      if (target.startsWith('../') || !this.zip.file(target))
        officeError('Office 内部关系指向缺失的成员');
      const id = rel.getAttribute('Id')!;
      if (links.has(id)) officeError('Office 关系 ID 重复');
      links.set(id, target);
    }
    return links;
  }
  async orderedParts() {
    const part = mainParts[this.format],
      doc = await this.xml(part),
      links = await this.links(part);
    const entries =
      this.format === 'xlsx'
        ? elements(doc, ns.s, 'sheet')
        : elements(doc, ns.p, 'sldId');
    return entries.map((entry, index) => {
      const target = links.get(entry.getAttributeNS(ns.r, 'id') ?? '');
      if (!target) officeError('Office 工作表或幻灯片关系缺失');
      return {
        path: target,
        name: entry.getAttribute('name') ?? String(index + 1),
        index: index + 1,
      };
    });
  }
  async finish() {
    const serializer = new XMLSerializer();
    for (const path of this.changed) {
      const doc = this.documents.get(path)!;
      // xmldom represents the XML declaration as a PI; its strict serializer
      // correctly rejects reserved PI targets. Emit a UTF-8 declaration once.
      for (const node of Array.from(doc.childNodes))
        if (node.nodeType === 7 && node.nodeName === 'xml')
          doc.removeChild(node);
      this.zip.file(
        path,
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          serializer.serializeToString(doc, { requireWellFormed: true }),
        { date: this.zip.file(path)!.date, createFolders: false },
      );
    }
    return this.zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    });
  }
}
