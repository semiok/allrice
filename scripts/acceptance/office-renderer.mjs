import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createOffice } from '../../apps/worker/dist/office/create.js';
import { checkOfficeExport } from '../../apps/worker/dist/office/quality.js';
import { renderOffice } from '../../packages/office-runtime/dist/index.js';
import { OfficeCreateSchema } from '../../packages/contracts/dist/index.js';

const require = createRequire(
  new URL('../../apps/worker/package.json', import.meta.url),
);
const ExcelJS = require('exceljs');
const examples = [
  {
    kind: 'docx',
    title: 'Office 验收',
    blocks: [
      { type: 'heading', text: '中文标题' },
      { type: 'table', headers: ['名称', '金额'], rows: [['保留文本', 30]] },
    ],
  },
  {
    kind: 'xlsx',
    sheets: [
      {
        name: '明细',
        columns: [
          { header: '编号' },
          { header: '金额' },
          { header: '合计' },
          { header: '错误示例' },
        ],
        rows: [['00123', 30, { formula: 'B2*2' }, { formula: '1/0' }]],
      },
      {
        name: '汇总',
        columns: [
          { header: '跨表公式' },
          { header: '文字结果' },
          { header: '布尔结果' },
        ],
        rows: [
          [
            { formula: "SUM('明细'!B2:C2)" },
            { formula: '"已完成"' },
            { formula: '1=1' },
          ],
        ],
      },
    ],
  },
  {
    kind: 'pptx',
    title: 'Office 验收',
    slides: [
      {
        title: '收入趋势',
        chart: {
          type: 'bar',
          labels: ['八月', '九月'],
          series: [{ name: '收入', values: [12, 20] }],
        },
      },
      {
        title: '数据明细',
        table: { headers: ['编号', '金额'], rows: [['00123', 30]] },
      },
    ],
  },
];
for (const input of examples) {
  const file = await createOffice(OfficeCreateSchema.parse(input));
  const checked = await checkOfficeExport(file.bytes, input.kind);
  assert.equal(
    checked.quality.status,
    'checked',
    JSON.stringify(checked.quality),
  );
  if (input.kind === 'xlsx') {
    assert.equal(checked.quality.formulaErrorCount, 1);
    assert.equal(checked.quality.formulaCount, 5);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(checked.bytes);
    assert.equal(book.getWorksheet('明细').getCell('C2').result, 60);
    assert.equal(book.getWorksheet('汇总').getCell('A2').result, 90);
    assert.equal(book.getWorksheet('汇总').getCell('B2').result, '已完成');
    assert.equal(book.getWorksheet('汇总').getCell('C2').result, true);
    assert.equal(
      book.getWorksheet('明细').getCell('D2').result.error,
      '#DIV/0!',
    );
    assert.equal(book.getWorksheet('明细').getCell('A2').value, '00123');
  } else assert.deepEqual(checked.bytes, file.bytes);
  // Real stored-file preview, including recalculated XLSX bytes, and cache retry.
  const preview = await renderOffice(checked.bytes, input.kind);
  const retry = await renderOffice(checked.bytes, input.kind);
  assert.deepEqual(retry, preview);
  assert.ok(preview.pages.length > 0);
  assert.equal(
    preview.checksum,
    'sha256:' + createHash('sha256').update(checked.bytes).digest('hex'),
  );
  console.log(
    `${input.kind}: ${preview.pageCount} pages; formula checks and exact-byte preview passed`,
  );
}

const shared = new ExcelJS.Workbook();
const sheet = shared.addWorksheet('共享公式');
sheet.getCell('A1').value = 10;
sheet.getCell('A2').value = 20;
sheet.fillFormula('B1:B2', 'A1*2');
const sharedChecked = await checkOfficeExport(
  Buffer.from(await shared.xlsx.writeBuffer()),
  'xlsx',
);
assert.equal(
  sharedChecked.quality.status,
  'checked',
  JSON.stringify(sharedChecked.quality),
);
const restored = new ExcelJS.Workbook();
await restored.xlsx.load(sharedChecked.bytes);
assert.equal(restored.worksheets[0].getCell('B1').result, 20);
assert.equal(restored.worksheets[0].getCell('B2').result, 40);
console.log(
  'shared formulas: original expressions retained, caches independently verified',
);
