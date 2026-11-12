import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  makeObjectKey,
  OfficeCreateSchema,
  type StorageObject,
} from '@allrice/contracts';
import type * as Database from '@allrice/database';
import {
  claimReferenceProcessing,
  failReferenceProcessing,
  finishReferenceProcessing,
} from '@allrice/database';
import { LocalStorageAdapter } from '@allrice/storage';
import { Document, Packer, Paragraph } from 'docx';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import PDFDocument from 'pdfkit';
import { processNextReference } from './reference-processing.js';
import { readKnowledgeText } from './knowledge.js';
import * as documentReader from './document-reader.js';
import { createOffice } from './office/create.js';
import JSZip from 'jszip';

vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  claimReferenceProcessing: vi.fn(),
  finishReferenceProcessing: vi.fn(),
  failReferenceProcessing: vi.fn(),
}));

const roots: string[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true })));
});

async function fixture(
  bytes: Uint8Array,
  mediaType: string,
  fileName = '部门金额.csv',
) {
  const root = await mkdtemp(join(tmpdir(), 'allrice-reference-text-'));
  roots.push(root);
  const id = randomUUID(),
    organizationId = randomUUID(),
    workspaceId = randomUUID(),
    ownerId = randomUUID();
  const object: StorageObject = {
    id,
    organizationId,
    workspaceId,
    ownerId,
    key: makeObjectKey({
      organizationId,
      workspaceId,
      ownerId,
      category: 'uploads',
      objectId: id,
    }),
    checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    mediaType,
    sizeBytes: bytes.byteLength,
    retentionUntil: null,
    deletedAt: null,
    immutable: true,
  };
  await new LocalStorageAdapter(root).put(
    object,
    new Blob([new Uint8Array(bytes)]).stream(),
  );
  const claim = {
    revisionId: randomUUID(),
    token: randomUUID(),
    fileName,
    object,
  };
  vi.mocked(claimReferenceProcessing).mockResolvedValue(claim);
  return { root, claim };
}

it.each(['text/plain', 'text/markdown', 'application/json', 'text/csv'])(
  'processes a claimed fixed %s source through verified storage and text indexing',
  async (mediaType) => {
    const text =
      '部门,账号,金额,备注\n运营,0012,12000,"含逗号,保留"\n财务,0034,18000,=1+1\n';
    const { root, claim } = await fixture(Buffer.from(text), mediaType);
    expect(await processNextReference(root)).toBe(true);
    expect(finishReferenceProcessing).toHaveBeenCalledExactlyOnceWith(
      claim,
      [{ content: text.trim(), start: 0, end: text.trim().length }],
      {
        kind: 'text',
        text,
        warnings: [],
        units: [{ label: '正文', start: 0, end: text.length }],
      },
    );
    expect(failReferenceProcessing).not.toHaveBeenCalled();
  },
);

it.each([
  { mediaType: 'application/octet-stream', sizeBytes: 20 },
  { mediaType: 'text/csv', sizeBytes: 2_000_001 },
  { mediaType: 'application/pdf', sizeBytes: 20 * 1024 * 1024 + 1 },
])(
  'rejects unsupported/big sources before attempting storage reads: %j',
  async (metadata) => {
    const { root, claim } = await fixture(
      Buffer.from('部门,金额\n运营,12000'),
      'text/csv',
    );
    Object.assign(claim.object, metadata);
    await rm(root, { recursive: true });
    roots.splice(roots.indexOf(root), 1);
    expect(await processNextReference(root)).toBe(true);
    expect(finishReferenceProcessing).not.toHaveBeenCalled();
    expect(failReferenceProcessing).toHaveBeenCalledExactlyOnceWith(
      claim,
      '文件已保存，可预览和下载；当前格式或大小暂不支持检索。',
      true,
    );
  },
);

it('does not index CSV with a changed declared checksum', async () => {
  const { root, claim } = await fixture(
    Buffer.from('部门,金额\n运营,12000'),
    'text/csv',
  );
  claim.object.checksum = `sha256:${'0'.repeat(64)}`;
  expect(await processNextReference(root)).toBe(true);
  expect(finishReferenceProcessing).not.toHaveBeenCalled();
  expect(failReferenceProcessing).toHaveBeenCalledExactlyOnceWith(
    claim,
    '资料文件校验失败',
  );
});

const pdfFixture = (name: string) =>
  readFileSync(
    new URL(`../../../tests/fixtures/pdf/${name}.pdf`, import.meta.url),
  );

it('keeps valid JSON source characters, large integer digits and duplicate fields verbatim', async () => {
  const text =
    ' \r\n{ "id":9007199254740993, "tag":"第一次", "tag":"第二次", "tail":"末尾中文" }\r\n ';
  const { root, claim } = await fixture(
    Buffer.from(text),
    'application/json',
    'verbatim.json',
  );
  await processNextReference(root);
  const fullText = vi.mocked(finishReferenceProcessing).mock.calls[0]![2]!;
  expect(fullText.text).toBe(text);
  expect(fullText.units).toEqual([
    { label: '正文', start: 0, end: text.length },
  ]);
  expect(fullText.text).toContain('9007199254740993');
  expect(fullText.text).toContain('"tag":"第一次", "tag":"第二次"');
  for (const chunk of vi.mocked(finishReferenceProcessing).mock.calls[0]![1])
    expect(fullText.text.slice(chunk.start, chunk.end)).toBe(chunk.content);
  expect(failReferenceProcessing).not.toHaveBeenCalled();
  const legacy = await fixture(
    Buffer.from('{"answer":42}'),
    'application/json',
  );
  expect(
    await readKnowledgeText(
      new LocalStorageAdapter(legacy.root),
      legacy.claim.object,
      true,
    ),
  ).toBe('{\n  "answer": 42\n}');
  expect(claim.object.checksum).toBe(
    `sha256:${createHash('sha256').update(text).digest('hex')}`,
  );
});

it.each([
  {
    quality: 'no_extractable_text' as const,
    warningCodes: ['PDF_NO_EXTRACTABLE_TEXT' as const],
    texts: ['\ufffd\u001f'],
  },
  {
    quality: 'digital_text' as const,
    warningCodes: ['PDF_NO_EXTRACTABLE_TEXT' as const],
    texts: ['尚存文字'],
  },
  {
    quality: 'digital_text' as const,
    warningCodes: [],
    texts: ['有效首页', '\ufffd\u001f\u007f'],
  },
])(
  'rejects native PDF no-text quality and invalid characters per page: %j',
  async ({ quality, warningCodes, texts }) => {
    const { root, claim } = await fixture(
      pdfFixture('01-chinese-multipage-digital'),
      'application/pdf',
      'quality.pdf',
    );
    // The source/lease/storage path is real. Only the native extraction response
    // is injected to cover its explicit quality contract for nonempty bad glyphs.
    const spy = vi
      .spyOn(documentReader, 'parseDocument')
      .mockResolvedValueOnce({
        kind: 'pdf',
        truncated: false,
        totalPages: texts.length,
        requestedPages: texts.map((_, index) => index + 1),
        nextPages: [],
        quality,
        warningCodes,
        parser: { name: 'pdf-parse', version: '2.4.5' },
        warnings: warningCodes.map(() => '未提取到可用文字层'),
        text: texts
          .map((text, index) => `## 第 ${index + 1} 页\n\n${text}`)
          .join('\n\n'),
        units: texts.map((text, index) => ({
          label: `第 ${index + 1} 页`,
          text,
          pageNumber: index + 1,
        })),
      });
    try {
      await processNextReference(root);
    } finally {
      spy.mockRestore();
    }
    expect(finishReferenceProcessing).not.toHaveBeenCalled();
    expect(failReferenceProcessing).toHaveBeenCalledExactlyOnceWith(
      claim,
      '部分页面没有可提取文字，尚不可全文检索；当前不执行 OCR。',
      true,
    );
  },
);

async function longPdf(
  pages: number,
  text = 'Page content',
  blankPage?: number,
) {
  const pdf = new PDFDocument({ autoFirstPage: false });
  const parts: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on('data', (part: Buffer) => parts.push(part));
    pdf.on('end', () => resolve(Buffer.concat(parts)));
    pdf.on('error', reject);
  });
  for (let page = 1; page <= pages; page++) {
    pdf.addPage();
    if (page !== blankPage) pdf.fontSize(10).text(`${page}: ${text}`, 40, 40);
  }
  pdf.end();
  return done;
}

it('visits physical PDF pages beyond the default first ten and keeps the final page', async () => {
  const { root } = await fixture(
    await longPdf(12, 'tail-page-sentinel'),
    'application/pdf',
    'twelve-pages.pdf',
  );
  await processNextReference(root);
  const body = vi.mocked(finishReferenceProcessing).mock.calls[0]![2]!;
  expect(body.units.map((unit) => unit.pageNumber)).toEqual(
    Array.from({ length: 12 }, (_, index) => index + 1),
  );
  expect(body.text.slice(body.units[11]!.start, body.units[11]!.end)).toContain(
    '12: tail-page-sentinel',
  );
  expect(failReferenceProcessing).not.toHaveBeenCalled();
});

it('does not mark a PDF complete when native extraction truncates a physical page', async () => {
  const { root } = await fixture(
    await longPdf(1, 'many words '.repeat(18_000)),
    'application/pdf',
    'too-much-text.pdf',
  );
  await processNextReference(root);
  expect(finishReferenceProcessing).not.toHaveBeenCalled();
  expect(failReferenceProcessing).toHaveBeenCalledWith(
    expect.anything(),
    '正文达到现有解析上限，尚不可全文检索。',
    true,
  );
});

it('does not infer every PDF page is searchable from a batch with some digital text', async () => {
  const { root, claim } = await fixture(
    await longPdf(2, 'digital text', 2),
    'application/pdf',
    'mixed.pdf',
  );
  await processNextReference(root);
  expect(finishReferenceProcessing).not.toHaveBeenCalled();
  expect(failReferenceProcessing).toHaveBeenCalledExactlyOnceWith(
    claim,
    '部分页面没有可提取文字，尚不可全文检索；当前不执行 OCR。',
    true,
  );
});

it('keeps the entire valid text, including a Chinese tail beyond the document preview character budget', async () => {
  const text = '收入与成本\n'.repeat(25_000) + '尾部唯一结论：本年总额九千元。';
  const { root } = await fixture(Buffer.from(text), 'text/plain', 'long.txt');
  await processNextReference(root);
  const body = vi.mocked(finishReferenceProcessing).mock.calls[0]![2]!;
  expect(body.text).toBe(text);
  expect(body.units).toEqual([{ label: '正文', start: 0, end: text.length }]);
  expect(
    vi.mocked(finishReferenceProcessing).mock.calls[0]![1].at(-1)!.content,
  ).toContain('尾部唯一结论');
  expect(failReferenceProcessing).not.toHaveBeenCalled();
});

it('stores all independently authored PDF pages and their physical locators', async () => {
  const { root } = await fixture(
    pdfFixture('01-chinese-multipage-digital'),
    'application/pdf',
    '资料.pdf',
  );
  await processNextReference(root);
  const body = vi.mocked(finishReferenceProcessing).mock.calls[0]![2]!;
  expect(body.kind).toBe('pdf');
  expect(body.units.map((unit) => unit.pageNumber)).toEqual([1, 2, 3]);
  expect(body.text).toContain('远山资料室');
  for (const unit of body.units)
    expect(body.text.slice(unit.start, unit.end).length).toBeGreaterThan(0);
  expect(failReferenceProcessing).not.toHaveBeenCalled();
});

it('persists native PDF table page, table and row locations without evaluating values', async () => {
  const { root } = await fixture(
    pdfFixture('02-ruled-invoice-table'),
    'application/pdf',
    'table.pdf',
  );
  await processNextReference(root);
  const body = vi.mocked(finishReferenceProcessing).mock.calls[0]![2]!;
  expect(body.tables).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        pageNumber: 1,
        tableNumber: 1,
        rows: expect.arrayContaining([
          expect.objectContaining({ rowNumber: 1, cells: expect.any(Array) }),
        ]),
      }),
    ]),
  );
});

it.each(['04-scanned-image-only', '05-password-protected'])(
  'never calls an incomplete or unreadable %s PDF fully indexed',
  async (name) => {
    const { root } = await fixture(
      pdfFixture(name),
      'application/pdf',
      'unreadable.pdf',
    );
    await processNextReference(root);
    expect(finishReferenceProcessing).not.toHaveBeenCalled();
    expect(failReferenceProcessing).toHaveBeenCalledOnce();
    expect(vi.mocked(failReferenceProcessing).mock.calls[0]![1]).not.toMatch(
      /\/Users\/|password|stack/i,
    );
  },
);

it('extracts the complete DOCX body with character positions, without inventing page numbers', async () => {
  const bytes = await Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
            new Paragraph('开始：零不是缺失。'),
            new Paragraph('最后段落：远期应付款。'),
          ],
        },
      ],
    }),
  );
  const { root } = await fixture(
    bytes,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '全文.docx',
  );
  await processNextReference(root);
  const body = vi.mocked(finishReferenceProcessing).mock.calls[0]![2]!;
  expect(body.text).toContain('最后段落：远期应付款。');
  expect(body.units).toEqual([expect.objectContaining({ label: '正文' })]);
  expect(body.units[0]!.start).toBe('## 正文\n\n'.length);
  expect(body.units[0]).not.toHaveProperty('pageNumber');
  expect(body.text.slice(body.units[0]!.start, body.units[0]!.end)).toContain(
    '开始',
  );
});

it('retains every XLSX sheet, including hidden sheets, strings and cached formulas', async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('首页').addRow(['编号', '00123']);
  const tail = workbook.addWorksheet('最终口径', { state: 'hidden' });
  tail.addRow(['最后金额', { formula: '1+2', result: 3 }, '0007']);
  const { root } = await fixture(
    Buffer.from(await workbook.xlsx.writeBuffer()),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '多表.xlsx',
  );
  await processNextReference(root);
  const body = vi.mocked(finishReferenceProcessing).mock.calls[0]![2]!;
  expect(body.units.map((unit) => unit.sheetName)).toEqual([
    '首页',
    '最终口径',
  ]);
  expect(body.text).toContain('=1+2（缓存：3）');
  expect(body.text).toContain('0007');
  const unit = body.units[1]!;
  expect(body.text.slice(unit.start, unit.end)).toContain('最后金额');
});

it('retains the final PPTX slide and its natural page position', async () => {
  const presentation = new PptxGenJS();
  presentation.addSlide().addText('第一页');
  presentation.addSlide().addText('末页中文结论');
  const { root } = await fixture(
    Buffer.from(
      (await presentation.write({ outputType: 'nodebuffer' })) as Buffer,
    ),
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '结论.pptx',
  );
  await processNextReference(root);
  const body = vi.mocked(finishReferenceProcessing).mock.calls[0]![2]!;
  expect(body.units.map((unit) => unit.pageNumber)).toEqual([1, 2]);
  expect(body.text.slice(body.units[1]!.start, body.units[1]!.end)).toBe(
    '末页中文结论',
  );
});

it.each(['complete', 'missing', 'sparse'] as const)(
  'extracts native PPTX chart facts or rejects an incomplete cache without publishing partial text: cache=%s',
  async (cache) => {
    const out = await createOffice(
      OfficeCreateSchema.parse({
        kind: 'pptx',
        title: '月报',
        slides: [
          {
            title: '图表页',
            chart: {
              type: 'bar',
              labels: ['九月', '十月'],
              series: [{ name: '收入', values: [12, 20] }],
            },
          },
        ],
      }),
    );
    let bytes = out.bytes;
    if (cache !== 'complete') {
      const zip = await JSZip.loadAsync(bytes);
      const charts = zip.file(/^ppt\/charts\/chart\d+\.xml$/);
      expect(charts).toHaveLength(1);
      const chart = charts[0];
      if (!chart) throw new Error('Expected the unique native chart fixture');
      const xml = await chart.async('string');
      expect(xml).toContain('<c:numCache>');
      const changed = xml.replace(
        /<c:numCache>[\s\S]*?<\/c:numCache>/g,
        (value) =>
          cache === 'missing'
            ? ''
            : value.replace(/<c:pt idx="1">[\s\S]*?<\/c:pt>/, ''),
      );
      expect(changed).not.toBe(xml);
      const changedCaches =
        changed.match(/<c:numCache>[\s\S]*?<\/c:numCache>/g) ?? [];
      if (cache === 'missing') expect(changedCaches).toHaveLength(0);
      else {
        expect(changedCaches.length).toBeGreaterThan(0);
        for (const value of changedCaches) {
          expect(value).toContain('<c:ptCount val="2"/>');
          expect(value).not.toContain('<c:pt idx="1">');
        }
      }
      zip.file(chart.name, changed);
      bytes = await zip.generateAsync({ type: 'nodebuffer' });
    }
    const { root, claim } = await fixture(bytes, out.mediaType, 'chart.pptx');
    await processNextReference(root);
    if (cache !== 'complete') {
      expect(finishReferenceProcessing).not.toHaveBeenCalled();
      expect(failReferenceProcessing).toHaveBeenCalledExactlyOnceWith(
        claim,
        '图表正文暂不能完整提取，尚不可全文检索；原文件已保留。',
        true,
      );
    } else {
      const fullText = vi.mocked(finishReferenceProcessing).mock.calls[0]![2]!;
      for (const value of ['图表页', '九月', '十月', '收入', '12', '20'])
        expect(fullText.text).toContain(value);
      expect(fullText.units.map((unit) => unit.pageNumber)).toEqual([1]);
      expect(failReferenceProcessing).not.toHaveBeenCalled();
    }
  },
);

it('does not treat an oversized DOCX preview as a complete body', async () => {
  const bytes = await Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
            new Paragraph('长正文'.repeat(45_000)),
            new Paragraph('不能丢失的尾部'),
          ],
        },
      ],
    }),
  );
  const { root, claim } = await fixture(
    bytes,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'over-limit.docx',
  );
  await processNextReference(root);
  expect(finishReferenceProcessing).not.toHaveBeenCalled();
  expect(failReferenceProcessing).toHaveBeenCalledExactlyOnceWith(
    claim,
    '正文达到现有解析上限，尚不可全文检索。',
    true,
  );
});

it('rejects invalid UTF-8 without publishing arbitrary parser or filesystem details', async () => {
  const { root, claim } = await fixture(
    Uint8Array.from([0xff, 0xfe]),
    'text/csv',
  );
  expect(await processNextReference(root)).toBe(true);
  expect(finishReferenceProcessing).not.toHaveBeenCalled();
  expect(failReferenceProcessing).toHaveBeenCalledExactlyOnceWith(
    claim,
    '资料处理失败，请重试；原文件已保留。',
  );
});
