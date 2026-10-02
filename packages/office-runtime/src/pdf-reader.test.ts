import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PDFParse } from 'pdf-parse';
import { describe, expect, it } from 'vitest';

import {
  PDF_MAXIMUM_INPUT_BYTES,
  PDF_MAXIMUM_PAGES,
  PDF_MAXIMUM_RESULT_BYTES,
  readPdfDocument,
} from './pdf-reader.ts';

interface ExpectedTable {
  pageNumber: number;
  tableIndex: number;
  matrix: string[][];
}

interface ExpectedFixture {
  fixtureId: string;
  fileName: string;
  sourceChecksum: string;
  pageCount: number;
  pages?: { pageNumber: number; requiredText: string[] }[];
  tables?: ExpectedTable[];
  requiredText?: string[];
  expectedNumeric?: { valid: number; missing: number; total: number };
}

const fixtureRoot = new URL('../../../tests/fixtures/pdf/', import.meta.url);
const expectationBytes = readFileSync(
  new URL('expected-source.json', fixtureRoot),
);
const expected = JSON.parse(expectationBytes.toString('utf8')) as {
  expectedTotals: { valid: number; missing: number; total: number };
  fixtures: ExpectedFixture[];
};
const manifest = JSON.parse(
  readFileSync(new URL('manifest.json', fixtureRoot), 'utf8'),
) as {
  files: { fileName: string; bytes: number; checksum: string }[];
  expectedSourceChecksum: string;
};
const checksum = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const fixture = (id: string) => {
  const value = expected.fixtures.find((value) => value.fixtureId === id);
  if (!value) throw new Error(`Missing independently authored fixture ${id}`);
  return {
    ...value,
    bytes: readFileSync(new URL(value.fileName, fixtureRoot)),
  };
};

// A small, dependency-free PDF authoring helper. The fixed fixtures above carry
// independent expected values; these ASCII documents exercise paging and size
// bounds without checking in a large fixture or borrowing parser output.
const pdfLiteral = (text: string) =>
  text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');

function pdfFromStreams(streams: string[]) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${streams.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${streams.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [i, stream] of streams.entries()) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const startxref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(body);
}

function textPdf(pages: string[]) {
  return pdfFromStreams(
    pages.map((text) => {
      const lines = text.match(/.{1,512}/gs) ?? [''];
      const fontSize = text.length > 2_000 ? 1 : 10;
      return `BT /F1 ${fontSize} Tf ${fontSize * 1.3} TL 20 760 Td ${lines
        .map((line) => `(${pdfLiteral(line)}) Tj`)
        .join(' T* ')} ET`;
    }),
  );
}

function tablePdf(matrix: string[][]) {
  const rows = matrix.length;
  const columns = matrix[0]!.length;
  const left = 20;
  const top = 750;
  const width = 110;
  const height = 25;
  const drawing = ['0.5 w'];
  for (let row = 0; row <= rows; row++) {
    const y = top - row * height;
    drawing.push(`${left} ${y} m ${left + columns * width} ${y} l S`);
  }
  for (let column = 0; column <= columns; column++) {
    const x = left + column * width;
    drawing.push(`${x} ${top} m ${x} ${top - rows * height} l S`);
  }
  for (const [row, cells] of matrix.entries()) {
    for (const [column, cell] of cells.entries()) {
      // Tiny text keeps each long stress cell inside its physical grid bounds.
      drawing.push(
        `BT /F1 0.04 Tf ${left + column * width + 2} ${top - row * height - 12} Td (${pdfLiteral(cell)}) Tj ET`,
      );
    }
  }
  return pdfFromStreams([drawing.join('\n')]);
}

// Confirm stress documents really reach the budget before checking the bounded
// reader. This observation is never used to supply the fixed fixtures' answers.
async function observedCopyBytes(bytes: Uint8Array, includeStructure = false) {
  const parser = new PDFParse({ data: bytes, isEvalSupported: false });
  try {
    const extracted = await parser.getText();
    const tables = includeStructure ? await parser.getTable() : undefined;
    const copies = {
      text: extracted.pages.map((page) => page.text).join('\n'),
      units: extracted.pages.map((page) => ({ text: page.text })),
      ...(tables
        ? {
            tables: tables.pages.flatMap((page) =>
              page.tables.map((rows) => ({
                rows: rows.map((cells) => ({ cells })),
              })),
            ),
          }
        : {}),
    };
    return {
      textCharacters: copies.text.length,
      tableCount: copies.tables?.length ?? 0,
      jsonBytes: Buffer.byteLength(JSON.stringify(copies), 'utf8'),
    };
  } finally {
    await parser.destroy();
  }
}

describe('fixed PDF source integrity', () => {
  it('uses the original independently authored annotation and a small fixture set', () => {
    expect(checksum(expectationBytes)).toBe(
      'sha256:2dfc344304c017db6a7a7ab37754a6fb09f47421e41c4c5d2c6ea36289088692',
    );
    expect(manifest.expectedSourceChecksum).toBe(checksum(expectationBytes));
    expect(manifest.files).toHaveLength(6);
    expect(manifest.files.reduce((total, file) => total + file.bytes, 0)).toBe(
      431_563,
    );
  });

  it.each(expected.fixtures)(
    'keeps $fileName bound to its source hash',
    (value) => {
      const bytes = readFileSync(new URL(value.fileName, fixtureRoot));
      expect(checksum(bytes)).toBe(value.sourceChecksum);
      expect(
        manifest.files.find((file) => file.fileName === value.fileName),
      ).toEqual({
        fileName: value.fileName,
        bytes: bytes.byteLength,
        checksum: value.sourceChecksum,
        mediaType: 'application/pdf',
      });
    },
  );
});

describe('readPdfDocument with independently authored PDFs', () => {
  it('returns only requested physical page 2 with its Chinese source anchors', async () => {
    const source = fixture('01-chinese-multipage-digital');
    const parsed = await readPdfDocument({ bytes: source.bytes, pages: [2] });
    expect(parsed).toMatchObject({
      kind: 'pdf',
      totalPages: source.pageCount,
      requestedPages: [2],
      nextPages: [3],
      quality: 'digital_text',
      parser: { name: 'pdf-parse', version: '2.4.5' },
    });
    expect(parsed.units.map((unit) => unit.pageNumber)).toEqual([2]);
    for (const text of source.pages![1]!.requiredText) {
      expect(parsed.text).toContain(text);
      expect(parsed.units[0]!.text).toContain(text);
    }
    const json = JSON.stringify(parsed);
    expect(json).not.toContain('青松办公室');
    expect(json).not.toContain('远山资料室');
    expect(parsed.truncated).toBe(true);
    expect(parsed.warningCodes).toContain('PDF_PAGES_TRUNCATED');
  });

  it('sorts and deduplicates requested pages without duplicating content', async () => {
    const source = fixture('01-chinese-multipage-digital');
    const parsed = await readPdfDocument({
      bytes: source.bytes,
      pages: [3, 2, 2],
    });
    expect(parsed.requestedPages).toEqual([2, 3]);
    expect(parsed.units.map((unit) => unit.pageNumber)).toEqual([2, 3]);
    expect(parsed.units).toHaveLength(2);
    expect(parsed.nextPages).toEqual([]);
    expect(parsed.text.indexOf('星河实验室')).toBeLessThan(
      parsed.text.indexOf('远山资料室'),
    );
    expect(JSON.stringify(parsed)).not.toContain('青松办公室');
  });

  it('preserves every ruled-table string and the independently authored numeric facts', async () => {
    const source = fixture('02-ruled-invoice-table');
    const parsed = await readPdfDocument({
      bytes: source.bytes,
      includeStructure: true,
    });
    expect(parsed.tables).toHaveLength(1);
    const table = parsed.tables![0]!;
    expect(table.pageNumber).toBe(1);
    expect(table.tableNumber).toBe(1);
    expect(table.rows.map((row) => row.rowNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(table.rows.map((row) => row.cells)).toEqual(
      source.tables![0]!.matrix,
    );
    expect(
      table.rows
        .flatMap((row) => row.cells)
        .every((cell) => typeof cell === 'string'),
    ).toBe(true);
    const rows = table.rows.slice(1);
    expect(rows.map((row) => row.cells[0])).toEqual([
      '00123',
      '00456',
      '00789',
      '00999',
    ]);
    expect(rows[1]!.cells[3]).toBe('-200.00');
    expect(rows[2]!.cells[3]).toBe('—');
    const amounts = rows
      .map((row) => row.cells[3]!)
      .filter((value) => /^-?\d+\.\d{2}$/.test(value))
      .map(Number);
    expect(amounts).toHaveLength(expected.expectedTotals.valid);
    expect(rows.length - amounts.length).toBe(expected.expectedTotals.missing);
    expect(amounts.reduce((total, value) => total + value, 0)).toBe(
      expected.expectedTotals.total,
    );
    expect(parsed.warningCodes).toContain('PDF_TABLE_HEURISTIC');
  });

  it('keeps cross-page table fragments and repeated headers tied to their physical pages', async () => {
    const source = fixture('03-cross-page-ruled-table');
    const parsed = await readPdfDocument({
      bytes: source.bytes,
      includeStructure: true,
    });
    expect(parsed.totalPages).toBe(2);
    expect(parsed.tables).toHaveLength(2);
    for (const [index, expectedTable] of source.tables!.entries()) {
      const actual = parsed.tables![index]!;
      expect(actual.pageNumber).toBe(expectedTable.pageNumber);
      expect(actual.tableNumber).toBe(expectedTable.tableIndex + 1);
      expect(actual.rows.map((row) => row.cells)).toEqual(expectedTable.matrix);
      expect(actual.rows.map((row) => row.rowNumber)).toEqual([1, 2, 3]);
    }
    expect(parsed.warningCodes).toContain('PDF_TABLE_FRAGMENTS_NOT_MERGED');
    const secondPage = await readPdfDocument({
      bytes: source.bytes,
      pages: [2],
      includeStructure: true,
    });
    expect(secondPage.tables).toHaveLength(1);
    expect(secondPage.tables![0]!.pageNumber).toBe(2);
    expect(secondPage.tables![0]!.rows.map((row) => row.cells)).toEqual(
      source.tables![1]!.matrix,
    );
    expect(JSON.stringify(secondPage)).not.toContain('00123');
    expect(JSON.stringify(secondPage)).not.toContain('00456');
  });

  it('returns borderless text without inventing a structured table', async () => {
    const source = fixture('06-borderless-layout');
    const parsed = await readPdfDocument({
      bytes: source.bytes,
      includeStructure: true,
    });
    for (const text of source.requiredText!)
      expect(parsed.text).toContain(text);
    expect(parsed.quality).toBe('digital_text');
    expect(parsed.tables).toEqual([]);
    expect(parsed.warningCodes).toContain('PDF_TABLE_NOT_DETECTED');
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it('reports image-only scans as having no extractable text and no OCR', async () => {
    const source = fixture('04-scanned-image-only');
    const parsed = await readPdfDocument({
      bytes: source.bytes,
      includeStructure: true,
    });
    expect(parsed.totalPages).toBe(source.pageCount);
    expect(parsed.quality).toBe('no_extractable_text');
    expect(parsed.units.map((unit) => unit.pageNumber)).toEqual([1, 2]);
    expect(parsed.units.every((unit) => unit.text.trim().length === 0)).toBe(
      true,
    );
    expect(parsed.tables).toEqual([]);
    expect(parsed.warningCodes).toContain('PDF_NO_EXTRACTABLE_TEXT');
    expect(parsed.warnings.join(' ')).toMatch(/OCR|文字层|文本层/);
    expect(JSON.stringify(parsed)).not.toContain('1250.50');
  });

  it('omits heuristic table work when structure was not requested', async () => {
    const source = fixture('02-ruled-invoice-table');
    const parsed = await readPdfDocument({ bytes: source.bytes });
    expect(parsed.text).toContain('00123');
    expect(parsed.tables).toBeUndefined();
    expect(parsed.warningCodes).not.toContain('PDF_TABLE_HEURISTIC');
  });

  it('distinguishes password protection from a damaged PDF', async () => {
    await expect(
      readPdfDocument({ bytes: fixture('05-password-protected').bytes }),
    ).rejects.toMatchObject({ code: 'PDF_PASSWORD_REQUIRED' });
    await expect(
      readPdfDocument({ bytes: Buffer.from('%PDF-1.4\ntruncated document') }),
    ).rejects.toMatchObject({ code: 'PDF_PARSE_FAILED' });
  });
});

describe('PDF request and complete JSON bounds', () => {
  it('rejects oversized input before parsing', async () => {
    await expect(
      readPdfDocument({ bytes: new Uint8Array(PDF_MAXIMUM_INPUT_BYTES + 1) }),
    ).rejects.toMatchObject({ code: 'PDF_INPUT_TOO_LARGE' });
  });

  it.each(
    [
      [],
      [0],
      [-1],
      [1.5],
      [Number.MAX_SAFE_INTEGER + 1],
      Array<number>(11).fill(1),
    ].map((pages) => ({ pages })),
  )('rejects invalid page numbers $pages', async ({ pages }) => {
    await expect(
      readPdfDocument({
        bytes: fixture('01-chinese-multipage-digital').bytes,
        pages,
      }),
    ).rejects.toMatchObject({ code: 'PDF_INVALID_OPTIONS' });
  });

  it('rejects a valid integer beyond the actual physical page count', async () => {
    await expect(
      readPdfDocument({
        bytes: fixture('01-chinese-multipage-digital').bytes,
        pages: [4],
      }),
    ).rejects.toMatchObject({ code: 'PDF_PAGE_OUT_OF_RANGE' });
  });

  it('pages a longer document without silently reading or repeating page 11', async () => {
    const source = textPdf(
      Array.from(
        { length: PDF_MAXIMUM_PAGES + 1 },
        (_, index) => `PHYSICAL-PAGE-${index + 1}-END`,
      ),
    );
    const first = await readPdfDocument({ bytes: source });
    expect(first.totalPages).toBe(PDF_MAXIMUM_PAGES + 1);
    expect(first.requestedPages).toEqual(
      Array.from({ length: PDF_MAXIMUM_PAGES }, (_, index) => index + 1),
    );
    expect(first.nextPages).toEqual([PDF_MAXIMUM_PAGES + 1]);
    expect(first.truncated).toBe(true);
    expect(JSON.stringify(first)).not.toContain('PHYSICAL-PAGE-11-END');
    const last = await readPdfDocument({
      bytes: source,
      pages: first.nextPages,
    });
    expect(last.units.map((unit) => unit.pageNumber)).toEqual([11]);
    expect(last.text).toContain('PHYSICAL-PAGE-11-END');
    expect(last.nextPages).toEqual([]);
    await expect(
      readPdfDocument({
        bytes: source,
        pages: Array.from({ length: 11 }, (_, i) => i + 1),
      }),
    ).rejects.toMatchObject({ code: 'PDF_INVALID_OPTIONS' });
  });

  it('bounds every returned text copy, not only the joined text', async () => {
    const source = textPdf(['Small-char-budget '.repeat(200)]);
    expect((await observedCopyBytes(source)).textCharacters).toBeGreaterThan(
      1_000,
    );
    const full = await readPdfDocument({
      bytes: source,
      includeStructure: true,
    });
    const limited = await readPdfDocument({
      bytes: source,
      includeStructure: true,
      maximumCharacters: 1_000,
    });
    expect(limited.truncated).toBe(true);
    expect(limited.warningCodes).toContain('PDF_CONTENT_TRUNCATED');
    expect(limited.nextPages).toContain(1);
    expect(limited.text.length).toBeLessThanOrEqual(1_000);
    expect(
      limited.units.reduce((sum, unit) => sum + unit.text.length, 0),
    ).toBeLessThanOrEqual(1_000);
    expect(Buffer.byteLength(JSON.stringify(limited))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(full)),
    );
  });

  it('enforces the UTF-8 JSON budget including both returned text copies', async () => {
    const text = 'JSON-budget "quoted" \\ '.repeat(12_000);
    const source = textPdf([text]);
    expect(source.byteLength).toBeLessThan(PDF_MAXIMUM_INPUT_BYTES);
    expect(
      Buffer.byteLength(
        JSON.stringify({
          text,
          units: [{ text }],
        }),
      ),
    ).toBeGreaterThan(PDF_MAXIMUM_RESULT_BYTES);
    expect((await observedCopyBytes(source)).jsonBytes).toBeGreaterThan(
      PDF_MAXIMUM_RESULT_BYTES,
    );
    const parsed = await readPdfDocument({
      bytes: source,
      maximumCharacters: 300_000,
      includeStructure: true,
    });
    expect(parsed.truncated).toBe(true);
    expect(parsed.warningCodes).toContain('PDF_CONTENT_TRUNCATED');
    expect(parsed.nextPages).toContain(1);
    expect(
      Buffer.byteLength(JSON.stringify(parsed), 'utf8'),
    ).toBeLessThanOrEqual(PDF_MAXIMUM_RESULT_BYTES);
    expect(parsed.text.length).toBeLessThan(text.length);
    expect(parsed.units[0]!.text.length).toBeLessThan(text.length);
  }, 20_000);

  it('counts real structured table rows as well as text and units in the JSON budget', async () => {
    const matrix = Array.from({ length: 25 }, (_, row) =>
      Array.from(
        { length: 5 },
        (_, column) => `R${row + 1}C${column + 1}=${'"\\'.repeat(350)}`,
      ),
    );
    const text = matrix.map((row) => row.join('\t')).join('\n');
    const unbounded = {
      text,
      units: [{ text }],
      tables: [{ rows: matrix.map((cells) => ({ cells })) }],
    };
    expect(JSON.stringify(unbounded).length).toBeGreaterThan(
      PDF_MAXIMUM_RESULT_BYTES,
    );
    const source = tablePdf(matrix);
    const observed = await observedCopyBytes(source, true);
    expect(observed.tableCount).toBeGreaterThan(0);
    expect(observed.jsonBytes).toBeGreaterThan(PDF_MAXIMUM_RESULT_BYTES);
    const parsed = await readPdfDocument({
      bytes: source,
      includeStructure: true,
      maximumCharacters: 300_000,
    });
    expect(parsed.tables!.length).toBeGreaterThan(0);
    expect(parsed.tables![0]!.rows.length).toBeGreaterThan(0);
    expect(parsed.truncated).toBe(true);
    expect(parsed.warningCodes).toContain('PDF_CONTENT_TRUNCATED');
    expect(parsed.nextPages).toContain(1);
    expect(
      Buffer.byteLength(JSON.stringify(parsed), 'utf8'),
    ).toBeLessThanOrEqual(PDF_MAXIMUM_RESULT_BYTES);
  }, 20_000);
});
