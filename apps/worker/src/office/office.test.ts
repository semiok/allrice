import { Document, Packer, Paragraph } from 'docx';
import JSZip from 'jszip';
import { expect, it } from 'vitest';
import { inspectOffice } from './inspect.js';
import { OfficePackage, children, mainParts, ns } from './package.js';

it('bounds inspection and rejects mismatched formats, DTD and escaped archive paths', async () => {
  const out = {
    bytes: await Packer.toBuffer(
      new Document({
        sections: [{ children: [new Paragraph('x'.repeat(2000))] }],
      }),
    ),
  };
  const inspected = await inspectOffice(out.bytes, 'docx', 1000);
  expect(inspected.truncated).toBe(true);
  expect(
    inspected.units.reduce((n, u) => n + u.text.length, 0),
  ).toBeLessThanOrEqual(1000);
  await expect(OfficePackage.open(out.bytes, 'xlsx')).rejects.toThrow(
    '格式与包内容不一致',
  );
  const zip = await JSZip.loadAsync(out.bytes);
  zip.file(
    'word/document.xml',
    `<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><w:document xmlns:w="${ns.w}"/>`,
  );
  await expect(
    OfficePackage.open(await zip.generateAsync({ type: 'nodebuffer' }), 'docx'),
  ).rejects.toThrow('DTD');
  zip.file('evil/../escaped.xml', '<x/>');
  await expect(
    OfficePackage.open(await zip.generateAsync({ type: 'nodebuffer' }), 'docx'),
  ).rejects.toThrow('路径');
  expect(
    children(
      (await OfficePackage.open(out.bytes, 'docx')).documents.get(
        mainParts.docx,
      )!.documentElement!,
      ns.w,
      'body',
    ),
  ).toHaveLength(1);
});
