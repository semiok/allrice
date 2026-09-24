import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { officePreview, renderOffice } from './index.ts';

const bytes = Buffer.from('a synthetic package');
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=';
const result = () => ({
  checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  format: 'xlsx' as const,
  engine: 'LibreOffice test',
  pageCount: 1,
  pages: [{ number: 1, base64: png }],
  formulas: [],
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe('Office renderer protocol', () => {
  it('binds results to the exact input and limits frontend formula rows', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(result()));
    vi.stubGlobal('fetch', fetcher);
    expect(await renderOffice(bytes, 'xlsx')).toEqual(result());
    const options = fetcher.mock.calls[0]![1] as RequestInit;
    expect(options.redirect).toBe('error');
    expect(JSON.parse(String(options.body))).toMatchObject({
      base64: bytes.toString('base64'),
      checksum: result().checksum,
    });
    const formulas = Array.from({ length: 80 }, (_, i) => ({
      sheet: '明细',
      cell: `C${i + 1}`,
      formula: '1+1',
      type: 'n' as const,
      value: 2,
    }));
    const preview = officePreview({
      ...result(),
      formulas: [
        ...formulas,
        {
          sheet: '明细',
          cell: 'C81',
          formula: '1/0',
          type: 'e',
          value: '#DIV/0!',
        },
      ],
    });
    expect(preview.formulaCount).toBe(81);
    expect(preview.formulaErrorCount).toBe(1);
    expect(preview.formulas).toHaveLength(50);
    expect(preview.formulas[0]?.type).toBe('e');
  });
  it('rejects mismatched content, oversized bodies, invalid rasters and excessive pages', async () => {
    for (const response of [
      Response.json({ ...result(), checksum: `sha256:${'0'.repeat(64)}` }),
      Response.json({ ...result(), format: 'docx' }),
      Response.json({
        ...result(),
        pages: [
          { number: 1, base64: Buffer.from('<svg/>').toString('base64') },
        ],
      }),
      Response.json({
        ...result(),
        pages: Array.from({ length: 9 }, (_, i) => ({
          number: i + 1,
          base64: png,
        })),
      }),
      new Response('x'.repeat(8_000_001)),
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      await expect(renderOffice(bytes, 'xlsx')).rejects.toThrow();
    }
  });
  it('does not follow document URLs or expose renderer diagnostics', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ code: 'unsupported_formula_range' }, { status: 422 }),
        ),
    );
    await expect(renderOffice(bytes, 'xlsx')).rejects.toThrow(
      'unsupported_formula_range',
    );
    vi.stubEnv('ALLRICE_OFFICE_RENDERER_URL', 'file:///private');
    await expect(renderOffice(bytes, 'xlsx')).rejects.toThrow(
      'invalid_renderer_url',
    );
  });
});
