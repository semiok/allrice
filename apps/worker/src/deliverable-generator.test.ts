import { describe, expect, it } from 'vitest';

import { generateDeliverable } from './deliverable-generator.js';

describe('formal deliverable generation', () => {
  it.each([
    ['docx', 'PK'],
    ['xlsx', 'PK'],
    ['pptx', 'PK'],
    ['pdf', '%PDF'],
  ] as const)('generates a real %s container', async (format, signature) => {
    const generated = await generateDeliverable({
      format,
      content: '# AllRice\n\n可信交付内容',
    });
    expect(generated.bytes.subarray(0, signature.length).toString()).toBe(
      signature,
    );
    expect(generated.bytes.byteLength).toBeGreaterThan(200);
  });

  it('turns JSON rows into an Excel workbook', async () => {
    const generated = await generateDeliverable({
      format: 'xlsx',
      content: JSON.stringify([
        { name: 'Rice', status: 'ready' },
        { name: 'Snow', status: 'active' },
      ]),
    });
    expect(generated.mediaType).toContain('spreadsheetml');
    expect(generated.extension).toBe('.xlsx');
  });
});
