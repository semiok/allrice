import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { Document, Packer, Paragraph } from 'docx';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type PptxGenJSModule from 'pptxgenjs';
import { zipSync } from 'fflate';
import { parseReferenceArchiveText } from './reference-archive.js';
const PptxGenJS: typeof PptxGenJSModule.default = createRequire(
  import.meta.url,
)('pptxgenjs');
const signal = () => new AbortController().signal;
it.each(['txt', 'md', 'json', 'csv'])(
  'preserves complete UTF-16 source text, BOM and literal cell values for %s',
  async (extension) => {
    const text = '\uFEFF正文😀\r\n00123,-200.00,=1+1\n';
    expect(
      await parseReferenceArchiveText(
        Buffer.from(text),
        `member.${extension}`,
        signal(),
      ),
    ).toMatchObject({
      fullText: { text, kind: 'text', units: [{ start: 0, end: text.length }] },
    });
  },
);
it('uses the existing complete Office parsers for selected DOCX, XLSX and PPTX bytes', async () => {
  const docx = await Packer.toBuffer(
    new Document({
      sections: [{ children: [new Paragraph('archive DOCX evidence')] }],
    }),
  );
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Amounts').addRow(['archive XLSX evidence', 123]);
  const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
  const slides = new PptxGenJS();
  slides
    .addSlide()
    .addText('archive PPTX evidence', { x: 1, y: 1, w: 4, h: 1 });
  const pptx = Buffer.from(
    (await slides.write({ outputType: 'nodebuffer' })) as Buffer,
  );
  for (const [extension, bytes] of [
    ['docx', docx],
    ['xlsx', xlsx],
    ['pptx', pptx],
  ] as const) {
    const parsed = await parseReferenceArchiveText(
      bytes,
      `member.${extension}`,
      signal(),
    );
    expect(parsed.fullText.text).toContain(
      `archive ${extension.toUpperCase()} evidence`,
    );
    expect(parsed.fullText.kind).toBe(extension);
    expect(parsed.fullText.units.length).toBeGreaterThan(0);
  }
});
it('extracts all PDF physical pages and preserves their locations', async () => {
  const pdf = new PDFDocument();
  const chunks: Buffer[] = [];
  const bytes = new Promise<Buffer>((resolve, reject) => {
    pdf.on('data', (chunk) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
  });
  pdf.text('First archive page');
  pdf.addPage().text('Second archive page');
  pdf.end();
  const parsed = await parseReferenceArchiveText(
    await bytes,
    'member.pdf',
    signal(),
  );
  expect(parsed.fullText.totalPages).toBe(2);
  expect(parsed.fullText.text).toContain('Second archive page');
  expect(parsed.fullText.units.map((unit) => unit.pageNumber)).toEqual([1, 2]);
});
it('refuses partial Office text, malformed UTF-8, executable/nested bytes, oversized plain text and cancellation', async () => {
  const long = await Packer.toBuffer(
    new Document({
      sections: [{ children: [new Paragraph('x'.repeat(200000))] }],
    }),
  );
  await expect(
    parseReferenceArchiveText(long, 'member.docx', signal()),
  ).rejects.toMatchObject({ reason: 'text_unavailable' });
  await expect(
    parseReferenceArchiveText(Buffer.from([0xff]), 'member.txt', signal()),
  ).rejects.toMatchObject({ reason: 'text_unavailable' });
  await expect(
    parseReferenceArchiveText(
      Buffer.from('MZ executable'),
      'member.txt',
      signal(),
    ),
  ).rejects.toMatchObject({ reason: 'media_type' });
  await expect(
    parseReferenceArchiveText(
      Buffer.from(zipSync({ a: Buffer.from('x') })),
      'member.txt',
      signal(),
    ),
  ).rejects.toMatchObject({ reason: 'nested_archive' });
  await expect(
    parseReferenceArchiveText(
      Buffer.alloc(2000001, 97),
      'member.txt',
      signal(),
    ),
  ).rejects.toMatchObject({ reason: 'member_bytes' });
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  await expect(
    parseReferenceArchiveText(
      Buffer.from('text'),
      'member.txt',
      controller.signal,
    ),
  ).rejects.toThrow('stop');
});
