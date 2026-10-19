import { createHash } from 'node:crypto';
import type { OfficeFormulaResult } from '@allrice/contracts';
import type * as OfficeRuntime from '@allrice/office-runtime';
import { OfficeRenderError, renderOffice } from '@allrice/office-runtime';
import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectXlsxFormulaCaches } from './formula-cache.js';
import { checkOfficeExport } from './quality.js';

vi.mock('@allrice/office-runtime', async (original) => ({
  ...(await original<typeof OfficeRuntime>()),
  renderOffice: vi.fn(),
}));
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const P = 'http://schemas.openxmlformats.org/package/2006/relationships';
const digest = (bytes: Buffer) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
async function workbook(cells = '', shared?: string) {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
  );
  zip.file(
    'xl/workbook.xml',
    `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="明细" sheetId="1" r:id="s1"/></sheets></workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<Relationships xmlns="${P}"><Relationship Id="s1" Type="${R}/worksheet" Target="custom/sheet.xml"/>${shared !== undefined ? `<Relationship Id="ss" Type="${R}/sharedStrings" Target="custom/strings.xml"/>` : ''}</Relationships>`,
  );
  zip.file(
    'xl/custom/sheet.xml',
    `<worksheet xmlns="${S}"><sheetData><row r="1">${cells}</row></sheetData></worksheet>`,
  );
  if (shared !== undefined)
    zip.file('xl/custom/strings.xml', `<sst xmlns="${S}">${shared}</sst>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
const cell = (body: string, type?: string, ref = 'A1', attrs = '') =>
  `<c r="${ref}"${type ? ` t="${type}"` : ''}${attrs}><f>PRIVATE_FORMULA</f>${body}</c>`;
async function edit(bytes: Buffer, path: string, value: string) {
  const zip = await JSZip.loadAsync(bytes);
  zip.file(path, value);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
function rendered(bytes: Buffer, formulas: OfficeFormulaResult[] = []) {
  return {
    checksum: digest(bytes),
    format: 'xlsx' as const,
    engine: 'mock',
    pageCount: 1,
    pages: [{ number: 1, base64: 'not-used-by-mocked-render' }],
    formulas,
  };
}
const result = {
  sheet: '明细',
  cell: 'A1',
  formula: 'PRIVATE_FORMULA',
  type: 'n' as const,
  value: 0,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(renderOffice).mockRejectedValue(
    new Error('private-path-and-stderr'),
  );
});

describe('final XLSX formula cache facts', () => {
  it.each([
    ['absent v', '', undefined, 'missingCacheCount'],
    ['empty numeric v', '<v/>', undefined, 'missingCacheCount'],
    ['whitespace numeric v', '<v> </v>', 'n', 'missingCacheCount'],
    ['zero', '<v>0</v>', 'n', 'numericCacheCount'],
    ['negative', '<v>-10.5</v>', undefined, 'numericCacheCount'],
    ['exponent', '<v>1e-2</v>', 'n', 'numericCacheCount'],
    ['false', '<v>0</v>', 'b', 'booleanCacheCount'],
    ['true', '<v>1</v>', 'b', 'booleanCacheCount'],
    ['bad boolean', '<v>2</v>', 'b', 'invalidCacheCount'],
    ['explicit empty string', '<v/>', 'str', 'stringCacheCount'],
    ['string with spaces', '<v> </v>', 'str', 'stringCacheCount'],
    ['absent string v', '', 'str', 'missingCacheCount'],
    ['error', '<v>#DIV/0!</v>', 'e', 'errorCacheCount'],
    ['absent error', '', 'e', 'missingCacheCount'],
    ['hex is not numeric XML', '<v>0x10</v>', 'n', 'invalidCacheCount'],
    ['nonfinite', '<v>1e9999</v>', 'n', 'invalidCacheCount'],
    ['NaN', '<v>NaN</v>', 'n', 'invalidCacheCount'],
    ['two values', '<v>1</v><v>2</v>', 'n', 'invalidCacheCount'],
    ['nested value', '<v><t>1</t></v>', 'n', 'invalidCacheCount'],
    [
      'mixed inline/value',
      '<v>1</v><is><t>1</t></is>',
      'n',
      'invalidCacheCount',
    ],
  ])(
    '%s is classified without truthiness coercion',
    async (_, body, type, count) => {
      const bytes = await workbook(cell(body!, type)),
        original = Buffer.from(bytes);
      const facts = await inspectXlsxFormulaCaches(bytes);
      expect(facts.inspection).toBe('complete');
      if (facts.inspection !== 'complete') throw new Error(facts.code);
      expect(facts.counts.formulaCount).toBe(1);
      expect(facts.counts[count as keyof typeof facts.counts]).toBe(1);
      expect(Object.values(facts.counts).reduce((a, b) => a + b, 0)).toBe(2);
      expect(facts.checksum).toBe(digest(bytes));
      expect(bytes).toEqual(original);
      expect(JSON.stringify(facts)).not.toContain('PRIVATE_FORMULA');
    },
  );
  it.each([
    ['empty shared string', '<si><t/></si>', '0', 'stringCacheCount'],
    [
      'rich shared string',
      '<si><r><t>value</t></r><rPh sb="0" eb="1"><t>phonetic</t></rPh></si>',
      '0',
      'stringCacheCount',
    ],
    [
      'out of range shared string',
      '<si><t>value</t></si>',
      '1',
      'invalidCacheCount',
    ],
    ['negative shared string index', '<si/>', '-1', 'invalidCacheCount'],
    ['fractional shared string index', '<si/>', '.5', 'invalidCacheCount'],
    ['zero-padded shared string index', '<si/>', '+00', 'stringCacheCount'],
  ])('%s follows workbook relationships', async (_, shared, index, count) => {
    const facts = await inspectXlsxFormulaCaches(
      await workbook(cell(`<v>${index}</v>`, 's'), shared),
    );
    expect(facts.inspection).toBe('complete');
    if (facts.inspection === 'complete')
      expect(facts.counts[count as keyof typeof facts.counts]).toBe(1);
  });
  it('keeps a missing shared string table unknown', async () => {
    expect(
      await inspectXlsxFormulaCaches(await workbook(cell('<v>0</v>', 's'))),
    ).toMatchObject({ inspection: 'incomplete', code: 'invalid_structure' });
  });
  it('treats an explicit empty type differently from an absent default', async () => {
    const bytes = await workbook(
      cell('<v>0</v>').replace('r="A1"', 'r="A1" t=""'),
    );
    expect(await inspectXlsxFormulaCaches(bytes)).toMatchObject({
      inspection: 'incomplete',
      code: 'unsupported_cache_type',
    });
  });
  it.each(['inlineStr', 'd', 'unknown'])(
    'never accepts %s as a verified formula cache type',
    async (type) => {
      expect(
        await inspectXlsxFormulaCaches(
          await workbook(cell('<is><t/></is>', type)),
        ),
      ).toMatchObject({
        inspection: 'incomplete',
        code: 'unsupported_cache_type',
        observed: { unsupportedCacheCount: 1 },
      });
    },
  );
  it('leaves ordinary literal inline/shared string cells and zero-formula files alone', async () => {
    const bytes = await workbook(
      '<c r="A1" t="inlineStr"><is><t/></is></c><c r="B1" t="s"><v>0</v></c>',
    );
    const facts = await inspectXlsxFormulaCaches(bytes);
    expect(facts).toMatchObject({
      inspection: 'complete',
      counts: { formulaCount: 0 },
    });
    expect(JSON.stringify(facts)).not.toContain('passed');
  });
  it('counts shared followers and verifies their group and range without recalculating', async () => {
    const master =
      '<c r="A1"><f t="shared" si="0" ref="A1:B1">C1*2</f><v>0</v></c>';
    const follower = '<c r="B1"><f t="shared" si="0"/><v>1</v></c>';
    expect(
      await inspectXlsxFormulaCaches(
        await workbook(master.replace('si="0"', 'si="+00"') + follower),
      ),
    ).toMatchObject({
      inspection: 'complete',
      counts: { formulaCount: 2, numericCacheCount: 2 },
    });
    for (const cells of [
      follower,
      master + follower.replace('B1', 'C1'),
      master + master.replace('r="A1"', 'r="B1"'),
    ])
      expect(
        await inspectXlsxFormulaCaches(await workbook(cells)),
      ).toMatchObject({ inspection: 'incomplete', code: 'invalid_formula' });
  });
  it.each([
    '<c r="A1"><f t="array" ref="A1:B1">A2:A3*2</f><v>0</v></c>',
    '<c r="A1"><f t="dataTable" ref="A1:B1"/><v>0</v></c>',
    cell('<v>0</v>', undefined, 'A1', ' cm="1"'),
  ])('array/spill/table/metadata coverage stays unknown', async (cells) => {
    expect(await inspectXlsxFormulaCaches(await workbook(cells))).toMatchObject(
      {
        inspection: 'incomplete',
        code: 'unsupported_formula',
        observed: { unsupportedFormulaCount: 1 },
      },
    );
  });
  it('rejects ambiguous cells, empty normal formula and non-worksheet relationship targets', async () => {
    expect(
      await inspectXlsxFormulaCaches(
        await workbook(cell('<v>0</v>') + '<c r="A1"><v>1</v></c>'),
      ),
    ).toMatchObject({ inspection: 'incomplete', code: 'ambiguous_cells' });
    expect(
      await inspectXlsxFormulaCaches(
        await workbook(cell('<v>0</v>', undefined, 'XFE1')),
      ),
    ).toMatchObject({ inspection: 'incomplete', code: 'ambiguous_cells' });
    expect(
      await inspectXlsxFormulaCaches(
        await workbook('<c r="A1"><f/><v>0</v></c>'),
      ),
    ).toMatchObject({ inspection: 'incomplete', code: 'invalid_formula' });
    const bytes = await edit(
      await workbook(),
      'xl/custom/sheet.xml',
      `<chartsheet xmlns="${S}"/>`,
    );
    expect(await inspectXlsxFormulaCaches(bytes)).toMatchObject({
      inspection: 'incomplete',
      code: 'invalid_structure',
    });
  });
  it('limits formula and cell counts and never labels partial counts as totals', async () => {
    for (const body of [
      Array.from({ length: 10_001 }, (_, i) =>
        cell('<v>0</v>', 'n', `A${i + 1}`),
      ).join(''),
      Array.from(
        { length: 100_001 },
        (_, i) => `<c r="A${i + 1}"><v>0</v></c>`,
      ).join(''),
    ]) {
      const facts = await inspectXlsxFormulaCaches(await workbook(body));
      expect(facts).toMatchObject({
        inspection: 'incomplete',
        code: 'limit_exceeded',
      });
      expect('counts' in facts).toBe(false);
    }
  });
  it('reuses ZIP entry/XML resource limits and rejects malformed package bytes', async () => {
    expect(
      await inspectXlsxFormulaCaches(Buffer.from('not zip')),
    ).toMatchObject({ inspection: 'incomplete', code: 'invalid_package' });
    const zip = await JSZip.loadAsync(await workbook());
    for (let i = 0; i < 4097; i++) zip.file(`extra/${i}`, '');
    expect(
      await inspectXlsxFormulaCaches(
        await zip.generateAsync({ type: 'nodebuffer' }),
      ),
    ).toMatchObject({ inspection: 'incomplete', code: 'invalid_package' });
    for (const xml of [
      `<!DOCTYPE worksheet [<!ENTITY secret "value">]><worksheet xmlns="${S}"><sheetData/></worksheet>`,
      `<worksheet xmlns="${S}">${' '.repeat(8 * 1024 * 1024)}<sheetData/></worksheet>`,
    ])
      expect(
        await inspectXlsxFormulaCaches(
          await edit(await workbook(), 'xl/custom/sheet.xml', xml),
        ),
      ).toMatchObject({ inspection: 'incomplete', code: 'invalid_package' });
  });
});

describe('Office checking binds facts to actual returned bytes and preserves failure stages', () => {
  it('inspects successfully patched final caches once, with a final checksum', async () => {
    const bytes = await workbook(cell(''));
    vi.mocked(renderOffice).mockResolvedValue(rendered(bytes, [result]));
    const checked = await checkOfficeExport(bytes, 'xlsx');
    expect(checked.quality.status).toBe('checked');
    expect('savedValues' in checked && checked.savedValues).toMatchObject({
      inspection: 'complete',
      checksum: digest(checked.bytes),
      counts: { formulaCount: 1, numericCacheCount: 1, missingCacheCount: 0 },
    });
    expect(digest(checked.bytes)).not.toBe(digest(bytes));
    expect(await inspectXlsxFormulaCaches(bytes)).toMatchObject({
      inspection: 'complete',
      counts: { missingCacheCount: 1 },
    });
    expect(renderOffice).toHaveBeenCalledTimes(1);
  });
  it.each([
    [new OfficeRenderError('renderer_busy'), 'renderer', 'renderer_busy'],
    [
      new OfficeRenderError('conversion_timeout'),
      'renderer',
      'conversion_timeout',
    ],
    [new DOMException('private path', 'TimeoutError'), 'transport', 'timeout'],
    [
      new TypeError('private transport details', {
        cause: { code: 'ECONNREFUSED' },
      }),
      'transport',
      'transport_failed',
    ],
    [new TypeError('unknown original failure'), 'renderer', 'render_failed'],
    [new SyntaxError('private response'), 'renderer', 'protocol_invalid'],
    [
      new OfficeRenderError('private-unrecognized-code'),
      'renderer',
      'render_failed',
    ],
  ])(
    'keeps unavailable cause %s and original-byte cache facts',
    async (error, stage, code) => {
      const bytes = await workbook(cell(''));
      vi.mocked(renderOffice).mockRejectedValue(error);
      const checked = await checkOfficeExport(bytes, 'xlsx');
      expect(checked.bytes).toEqual(bytes);
      expect(checked.quality.status).toBe('unavailable');
      expect('diagnostic' in checked && checked.diagnostic).toEqual({
        stage,
        code,
      });
      expect('savedValues' in checked && checked.savedValues).toMatchObject({
        inspection: 'complete',
        counts: { missingCacheCount: 1 },
      });
      expect(checked.warnings.join('')).toContain('缺少已保存');
      expect(JSON.stringify(checked)).not.toContain('private-');
      expect(renderOffice).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    [[result, result], 'duplicate_result'],
    [[], 'result_missing'],
    [[{ ...result, formula: 'OTHER_FORMULA' }], 'formula_mismatch'],
    [[result, { ...result, cell: 'B1' }], 'unknown_result'],
  ] as const)(
    'reports cache patch failure %s without calling it a render failure',
    async (formulas, code) => {
      const bytes = await workbook(cell(''));
      vi.mocked(renderOffice).mockResolvedValue(rendered(bytes, [...formulas]));
      const checked = await checkOfficeExport(bytes, 'xlsx');
      expect(checked.bytes).toEqual(bytes);
      expect(checked.quality.status).toBe('unavailable');
      expect('diagnostic' in checked && checked.diagnostic).toEqual({
        stage: 'cache_patch',
        code,
      });
      expect('savedValues' in checked && checked.savedValues).toMatchObject({
        checksum: digest(bytes),
        inspection: 'complete',
        counts: { missingCacheCount: 1 },
      });
      expect(renderOffice).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    [{ ...result, type: 'b', value: false }, 'booleanCacheCount'],
    [{ ...result, type: 'str', value: '' }, 'stringCacheCount'],
    [{ ...result, type: 'e', value: '#DIV/0!' }, 'errorCacheCount'],
  ] as const)(
    'inspects the saved result type after cache patching',
    async (formula, count) => {
      const bytes = await workbook(cell(''));
      vi.mocked(renderOffice).mockResolvedValue(rendered(bytes, [formula]));
      const checked = await checkOfficeExport(bytes, 'xlsx');
      expect(checked.quality.status).toBe('checked');
      expect(checked.savedValues?.inspection).toBe('complete');
      if (checked.savedValues?.inspection === 'complete') {
        expect(checked.savedValues.counts[count]).toBe(1);
        expect(checked.savedValues.counts.missingCacheCount).toBe(0);
      }
      expect(renderOffice).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['docx', 'pptx'] as const)(
    'does not add XLSX inspection to %s',
    async (format) => {
      const bytes = Buffer.from('mock office bytes');
      vi.mocked(renderOffice).mockResolvedValue({ ...rendered(bytes), format });
      const checked = await checkOfficeExport(bytes, format);
      expect(checked.quality.status).toBe('checked');
      expect(checked.bytes).toEqual(bytes);
      expect(checked.savedValues).toBeUndefined();
      expect(checked.diagnostic).toBeUndefined();
      expect(renderOffice).toHaveBeenCalledTimes(1);
    },
  );
  it('does not replace the original renderer failure when independent inspection is incomplete', async () => {
    const bytes = await workbook(
      '<c r="A1"><f t="array" ref="A1:B1">A2:A3</f><v>0</v></c>',
    );
    vi.mocked(renderOffice).mockRejectedValue(
      new OfficeRenderError('renderer_busy'),
    );
    const checked = await checkOfficeExport(bytes, 'xlsx');
    expect('diagnostic' in checked && checked.diagnostic).toEqual({
      stage: 'renderer',
      code: 'renderer_busy',
    });
    expect('savedValues' in checked && checked.savedValues).toMatchObject({
      inspection: 'incomplete',
      code: 'unsupported_formula',
    });
  });
  it('does not call any renderer for local-only facts', async () => {
    const bytes = await workbook(cell(''));
    const checked = await checkOfficeExport(bytes, 'xlsx', {
      cloudQualityAllowed: false,
    });
    expect(checked.bytes).toEqual(bytes);
    expect('diagnostic' in checked && checked.diagnostic).toEqual({
      stage: 'local_policy',
      code: 'cloud_quality_disallowed',
    });
    expect('savedValues' in checked && checked.savedValues).toMatchObject({
      inspection: 'complete',
      counts: { missingCacheCount: 1 },
    });
    expect(renderOffice).not.toHaveBeenCalled();
  });
  it('retains normal success for an XLSX without formulas', async () => {
    const bytes = await workbook('<c r="A1"><v>0</v></c>');
    vi.mocked(renderOffice).mockResolvedValue(rendered(bytes));
    const checked = await checkOfficeExport(bytes, 'xlsx');
    expect(checked.quality.status).toBe('checked');
    expect(checked.bytes).toEqual(bytes);
    expect('savedValues' in checked && checked.savedValues).toMatchObject({
      inspection: 'complete',
      counts: { formulaCount: 0 },
    });
    expect(renderOffice).toHaveBeenCalledTimes(1);
  });
});
