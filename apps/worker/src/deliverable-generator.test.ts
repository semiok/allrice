import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { generateDeliverable } from './deliverable-generator.js';
import { parseDocument } from './document-reader.js';

describe('formal deliverable generation', () => {
  it('generates readable PPTX through the real development ESM loader', async () => {
    const moduleUrl = new URL('./deliverable-generator.ts', import.meta.url)
      .href;
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `import { generateDeliverable } from ${JSON.stringify(moduleUrl)};
       const file = await generateDeliverable(${JSON.stringify({ format: 'pptx', content: '# 中文交付\n测试服务费 30 元' })});
       process.stdout.write(file.bytes.toString('base64'));`,
    ]);
    const parsed = await parseDocument({
      bytes: Buffer.from(stdout, 'base64'),
      mediaType:
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      fileName: 'development.pptx',
    });
    expect(parsed.kind).toBe('pptx');
    expect(parsed.text).toContain('测试服务费 30 元');
  }, 15000);
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
