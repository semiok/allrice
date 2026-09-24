import { createRequire } from 'node:module';
import {
  Document,
  Footer,
  Header,
  HeadingLevel,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import ExcelJS from 'exceljs';
import type { OfficeCreate } from '@allrice/contracts';
import { officeError, officeMediaTypes } from './package.js';

const font = 'Noto Sans CJK SC';
function checkTable(headers: unknown[], rows: unknown[][]) {
  if (rows.some((row) => row.length !== headers.length))
    officeError('表格每行的列数必须与表头一致');
}
async function docx(input: Extract<OfficeCreate, { kind: 'docx' }>) {
  const blocks: (Paragraph | Table)[] = [
    new Paragraph({ text: input.title, heading: HeadingLevel.TITLE }),
  ];
  for (const block of input.blocks) {
    if (block.type === 'table') {
      checkTable(block.headers, block.rows);
      blocks.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [block.headers, ...block.rows].map(
            (row, index) =>
              new TableRow({
                tableHeader: index === 0,
                children: row.map(
                  (value) =>
                    new TableCell({
                      ...(index === 0 ? { shading: { fill: 'DBEAFE' } } : {}),
                      children: [
                        new Paragraph({
                          children: [
                            new TextRun({
                              text: value === null ? '' : String(value),
                              bold: index === 0,
                            }),
                          ],
                        }),
                      ],
                    }),
                ),
              }),
          ),
        }),
      );
    } else if (block.type === 'bullets')
      blocks.push(
        ...block.items.map(
          (text) => new Paragraph({ text, bullet: { level: 0 } }),
        ),
      );
    else if (block.type === 'page-break')
      blocks.push(new Paragraph({ children: [new PageBreak()] }));
    else if (block.type === 'heading')
      blocks.push(
        new Paragraph({
          text: block.text,
          heading: {
            '1': HeadingLevel.HEADING_1,
            '2': HeadingLevel.HEADING_2,
            '3': HeadingLevel.HEADING_3,
          }[block.level],
        }),
      );
    else
      blocks.push(
        new Paragraph({
          children: [new TextRun({ text: block.text, bold: block.bold })],
          spacing: { after: 120 },
        }),
      );
  }
  const document = new Document({
    creator: 'AllRice',
    title: input.title,
    styles: {
      default: {
        document: {
          run: { font, size: 22 },
          paragraph: { spacing: { after: 120 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 },
          },
        },
        ...(input.header
          ? {
              headers: {
                default: new Header({
                  children: [new Paragraph(input.header)],
                }),
              },
            }
          : {}),
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [
                  new TextRun(input.footer ? `${input.footer} · ` : ''),
                  new TextRun({ children: [PageNumber.CURRENT] }),
                ],
              }),
            ],
          }),
        },
        children: blocks,
      },
    ],
  });
  return Packer.toBuffer(document);
}

async function xlsx(input: Extract<OfficeCreate, { kind: 'xlsx' }>) {
  const names = input.sheets.map((s) => s.name.toLowerCase());
  if (new Set(names).size !== names.length)
    officeError('Excel 工作表名称不能重复');
  if (
    input.sheets.reduce(
      (count, s) => count + s.rows.length * s.columns.length,
      0,
    ) > 100_000
  )
    officeError('Excel 数据超过 100000 个单元格');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'AllRice';
  workbook.calcProperties.fullCalcOnLoad = true;
  for (const source of input.sheets) {
    checkTable(source.columns, source.rows);
    const sheet = workbook.addWorksheet(source.name);
    sheet.columns = source.columns.map((column) => ({
      header: column.header,
      width: column.width ?? 20,
      ...(column.numberFormat
        ? { style: { numFmt: column.numberFormat } }
        : {}),
    }));
    for (const row of source.rows)
      sheet.addRow(
        row.map((cell) =>
          cell !== null && typeof cell === 'object'
            ? { formula: cell.formula.replace(/^=/, '') }
            : cell,
        ),
      );
    sheet.getRow(1).font = {
      name: font,
      bold: true,
      color: { argb: 'FFFFFFFF' },
    };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF2563EB' },
    };
    sheet.getRow(1).height = 24;
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: source.rows.length + 1, column: source.columns.length },
    };
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

interface Presentation {
  author: string;
  title: string;
  layout: string;
  addSlide(): {
    background: { color: string };
    addText(text: string, options: Record<string, unknown>): void;
    addTable(rows: unknown[][], options: Record<string, unknown>): void;
    addChart(
      type: string,
      data: unknown[],
      options: Record<string, unknown>,
    ): void;
    addNotes(notes: string): void;
  };
  write(options: { outputType: 'nodebuffer' }): Promise<Buffer>;
}
async function pptx(input: Extract<OfficeCreate, { kind: 'pptx' }>) {
  const Constructor = createRequire(import.meta.url)(
    'pptxgenjs',
  ) as new () => Presentation;
  const deck = new Constructor();
  deck.author = 'AllRice';
  deck.title = input.title;
  deck.layout = 'LAYOUT_WIDE';
  for (const [index, source] of input.slides.entries()) {
    if (source.chart && source.table)
      officeError('一页只能选择图表或表格，请拆为两页');
    if ((source.chart || source.table) && source.body?.length)
      officeError('图表或表格页的补充说明请写在 notes 或单独文字页');
    const slide = deck.addSlide();
    slide.background = { color: 'FFFFFF' };
    slide.addText(source.title, {
      x: 0.65,
      y: 0.4,
      w: 12,
      h: 0.8,
      fontFace: font,
      fontSize: 26,
      bold: true,
      color: input.accentColor,
      fit: 'shrink',
      margin: 0,
    });
    if (source.table) {
      checkTable(source.table.headers, source.table.rows);
      if (source.table.rows.length > 12 || source.table.headers.length > 8)
        officeError('PPT 每页表格最多 12 行数据、8 列，请分成多页');
      slide.addTable(
        [
          source.table.headers.map((text) => ({
            text,
            options: { bold: true, color: 'FFFFFF', fill: input.accentColor },
          })),
          ...source.table.rows.map((row) =>
            row.map((cell) => (cell === null ? '' : String(cell))),
          ),
        ],
        {
          x: 0.65,
          y: 1.5,
          w: 12,
          h: 4.9,
          fontFace: font,
          fontSize: 14,
          border: { pt: 0.5, color: 'CBD5E1' },
          margin: 0.08,
          autoPage: false,
        },
      );
    } else if (source.chart) {
      const chart = source.chart;
      if (
        chart.series.some((s) => s.values.length !== chart.labels.length) ||
        (chart.type === 'pie' && chart.series.length !== 1)
      )
        officeError('图表数值必须与分类逐项对应；饼图只支持一个数据系列');
      slide.addChart(
        chart.type,
        chart.series.map((s) => ({
          name: s.name,
          labels: chart.labels,
          values: s.values,
        })),
        {
          x: 0.65,
          y: 1.5,
          w: 12,
          h: 4.9,
          showLegend: chart.series.length > 1 || chart.type === 'pie',
          showValue: true,
          showTitle: false,
          catAxisLabelFontFace: font,
          valAxisLabelFontFace: font,
          legendFontFace: font,
          chartColors: [
            input.accentColor,
            '059669',
            'D97706',
            '7C3AED',
            'DB2777',
            '0891B2',
          ],
        },
      );
    } else {
      slide.addText(source.body?.join('\n') ?? '', {
        x: 0.75,
        y: 1.55,
        w: 11.8,
        h: 4.8,
        fontFace: font,
        fontSize: 22,
        color: '1E293B',
        breakLine: false,
        valign: 'top',
        fit: 'shrink',
        paraSpaceAfterPt: 14,
        margin: 0,
      });
    }
    slide.addText(`${index + 1} / ${input.slides.length}`, {
      x: 11.7,
      y: 6.95,
      w: 1,
      h: 0.25,
      fontSize: 10,
      color: '64748B',
      align: 'right',
    });
    if (source.notes) slide.addNotes(source.notes);
  }
  return deck.write({ outputType: 'nodebuffer' });
}

export async function createOffice(input: OfficeCreate) {
  const bytes = await (input.kind === 'docx'
    ? docx(input)
    : input.kind === 'xlsx'
      ? xlsx(input)
      : pptx(input));
  return {
    bytes: Buffer.from(bytes),
    extension: `.${input.kind}`,
    mediaType: officeMediaTypes[input.kind],
    warnings:
      input.kind === 'xlsx'
        ? ['公式由 Excel/LibreOffice 打开时计算；此步骤未计算或核验公式结果。']
        : ['此步骤未进行渲染排版检查。'],
  };
}
