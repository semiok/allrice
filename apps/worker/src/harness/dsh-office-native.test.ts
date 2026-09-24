import { randomUUID } from 'node:crypto';
import {
  OfficeExportSchema,
  NativeOfficeExportSchema,
} from '@allrice/contracts';
import { expect, it } from 'vitest';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';

it('passes native Python Office work through the DSH broker without a typed editor', async () => {
  const objectId = randomUUID();
  const python = {
    inputs: [
      { path: 'source.xlsx', objectId, checksum: `sha256:${'a'.repeat(64)}` },
    ],
    sourceObjectId: objectId,
    script:
      "from openpyxl import Workbook\nWorkbook().save('/tmp/work/output/result.xlsx')",
  };
  await nativeBrokerRoundtrip({
    canonicalName: 'workspace.export.create',
    wireName: 'workspace_export_create',
    args: { fileName: '原生表格.xlsx', format: 'xlsx', python },
    invalidArgs: {
      fileName: '无效.xlsx',
      format: 'xlsx',
      python,
      inputs: python.inputs,
    },
    inspectSchema: (schema) => {
      expect(schema.properties).toMatchObject({
        python: {
          properties: { script: { type: 'string' }, inputs: { type: 'array' } },
        },
      });
      expect(schema.required).not.toContain('content');
    },
    onToolCall: async (call) => {
      expect(NativeOfficeExportSchema.parse(call.arguments.python).script).toBe(
        python.script,
      );
      return {
        modelContent: JSON.stringify({
          downloadUrl: '/api/v1/files/verified/download',
        }),
        summary: '已交付原生 Office',
      };
    },
  });
}, 45_000);

it('lists uploaded files through the native loop and returns object ids to the model', async () => {
  const id = randomUUID();
  await nativeBrokerRoundtrip({
    canonicalName: 'workspace.file.list',
    wireName: 'workspace_file_list',
    args: { limit: 50 },
    invalidArgs: { limit: 'fifty' },
    onToolCall: async () => ({
      modelContent: JSON.stringify([{ id, fileName: '模板.xlsx' }]),
      summary: '找到 1 个文件',
    }),
  });
}, 45_000);

it('forwards the Office structure request through the actual native declaration', async () => {
  await nativeBrokerRoundtrip({
    canonicalName: 'workspace.document.read',
    wireName: 'workspace_document_read',
    args: { objectId: randomUUID(), includeStructure: true },
    invalidArgs: { objectId: randomUUID(), includeStructure: 'true' },
    inspectSchema: (schema) => {
      expect(schema.properties).toHaveProperty('includeStructure');
    },
  });
}, 45_000);

it.each([
  {
    kind: 'docx',
    title: '客户报告',
    blocks: [
      { type: 'heading', text: '客户资料', level: 1 },
      { type: 'table', headers: ['客户'], rows: [['稻米公司']] },
    ],
  },
  {
    kind: 'xlsx',
    sheets: [
      {
        name: '明细',
        columns: [{ header: '金额' }, { header: '合计' }],
        rows: [[30, { formula: 'A2*2' }]],
      },
    ],
  },
  {
    kind: 'pptx',
    title: '客户汇报',
    slides: [
      {
        title: '收入',
        chart: {
          type: 'bar',
          labels: ['本月'],
          series: [{ name: '收入', values: [30] }],
        },
        notes: '口径说明',
      },
    ],
  },
  {
    kind: 'edit',
    sourceObjectId: randomUUID(),
    sourceChecksum: `sha256:${'a'.repeat(64)}`,
    changes: [{ type: 'set-cell', sheet: '明细', cell: 'B2', value: 30 }],
  },
])(
  'passes structured Office $kind without requiring legacy content',
  async (office) => {
    const format = office.kind === 'edit' ? 'xlsx' : office.kind;
    await nativeBrokerRoundtrip({
      canonicalName: 'workspace.export.create',
      wireName: 'workspace_export_create',
      args: { fileName: `结果.${format}`, format, office },
      invalidArgs: {
        fileName: `结果.${format}`,
        format,
        office: {
          kind: 'docx',
          title: '无效',
          blocks: [{ type: 'heading', text: '无效层级', level: 4 }],
        },
      },
      invalidResultIncludes: 'office.blocks.0.level',
      inspectSchema: (schema) => {
        expect(schema.properties).toHaveProperty('office');
        expect(schema.required).not.toContain('content');
      },
      onToolCall: async (call) => {
        expect(() =>
          OfficeExportSchema.parse(call.arguments.office),
        ).not.toThrow();
        return {
          modelContent: JSON.stringify({
            downloadUrl: '/api/v1/files/verified/download',
          }),
          summary: '已生成文件',
        };
      },
    });
  },
  45_000,
);
