import { randomUUID } from 'node:crypto';
import {
  OfficeExportSchema,
  NativeOfficeExportSchema,
  OfficePdfExportSchema,
} from '@allrice/contracts';
import { expect, it } from 'vitest';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';

it.each(['conflicting-mode', 'wrong-format'])(
  'passes the exact Office PDF source through native DSH and rejects %s',
  async (invalidCase) => {
    const officePdf = {
      objectId: randomUUID(),
      checksum: `sha256:${'a'.repeat(64)}`,
    };
    const args = { fileName: '同一报告.pdf', format: 'pdf', officePdf };
    await nativeBrokerRoundtrip({
      canonicalName: 'workspace.export.create',
      wireName: 'workspace_export_create',
      args,
      invalidArgs:
        invalidCase === 'conflicting-mode'
          ? { ...args, content: 'must not replace the Office conversion' }
          : { ...args, format: 'docx' },
      inspectSchema: (schema) => {
        expect(schema.properties).toMatchObject({
          officePdf: {
            additionalProperties: false,
            properties: {
              objectId: { type: 'string' },
              checksum: { type: 'string' },
            },
          },
        });
        expect(schema.required).not.toContain('content');
      },
      onToolCall: async (call) => {
        expect(call.arguments).toEqual(args);
        expect(OfficePdfExportSchema.parse(call.arguments.officePdf)).toEqual(
          officePdf,
        );
        return {
          modelContent: '{"objectId":"formal-PDF"}',
          summary: '正式 PDF',
        };
      },
    });
  },
  45_000,
);

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
      expect(call.arguments).not.toHaveProperty('location');
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

it.each([
  ['auto', 'invalid-location'],
  ['local', 'content'],
  ['cloud', 'legacy-office'],
] as const)(
  'declares and forwards top-level Office location=%s without changing the original arguments',
  async (location, invalidCase) => {
    const python = {
      inputs: [],
      script:
        "from openpyxl import Workbook\nWorkbook().save('/tmp/work/output/result.xlsx')",
    };
    const args = {
      fileName: '执行位置.xlsx',
      format: 'xlsx',
      python,
      location,
    };
    const invalidArgs =
      invalidCase === 'invalid-location'
        ? { ...args, location: 'host' }
        : invalidCase === 'content'
          ? {
              fileName: '正文.txt',
              format: 'text',
              content: 'synthetic only',
              location,
            }
          : {
              fileName: '兼容文档.docx',
              format: 'docx',
              office: {
                kind: 'docx',
                title: 'synthetic only',
                blocks: [{ type: 'paragraph', text: 'synthetic only' }],
              },
              location,
            };
    await nativeBrokerRoundtrip({
      canonicalName: 'workspace.export.create',
      wireName: 'workspace_export_create',
      args,
      invalidArgs,
      inspectSchema: (schema) => {
        expect(schema.properties).toMatchObject({
          location: { type: 'string', enum: ['auto', 'local', 'cloud'] },
        });
        expect(schema.required).not.toContain('location');
        const properties = schema.properties as Record<
          string,
          Record<string, unknown>
        >;
        expect(properties.location).not.toHaveProperty('default');
      },
      onToolCall: async (call) => {
        expect(call.arguments).toEqual(args);
        return { modelContent: '{}', summary: '原生执行位置通过' };
      },
    });
  },
  45_000,
);

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

it('accepts the real Office metadata shapes that previously caused four retries', async () => {
  const python = {
    inputs: [],
    script:
      "from openpyxl import Workbook\nWorkbook().save('/tmp/work/output/result.xlsx')",
    sourceObjectId: null,
    changeSummary: 'BTC 示例图表',
  };
  await nativeBrokerRoundtrip({
    canonicalName: 'workspace.export.create',
    wireName: 'workspace_export_create',
    args: { fileName: 'BTC图表.xlsx', format: 'xlsx', python },
    invalidArgs: {
      fileName: 'BTC图表.xlsx',
      format: 'xlsx',
      python: { ...python, sourceObjectId: 'invented' },
    },
    onToolCall: async (call) => {
      expect(NativeOfficeExportSchema.parse(call.arguments.python)).toEqual(
        python,
      );
      return { modelContent: '{}', summary: '原生参数通过' };
    },
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
