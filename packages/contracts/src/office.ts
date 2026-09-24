import { z } from 'zod';
import { CloudCommandInputSchema } from './runtime-v2/cloud-command.ts';

/** DSH's native Python Office workflow; Allrice only supplies files/runtime. */
export const NativeOfficeExportSchema = z
  .object({
    script: CloudCommandInputSchema.shape.script,
    inputs: CloudCommandInputSchema.shape.inputs,
    sourceObjectId: z.uuid().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.sourceObjectId &&
      !value.inputs.some((i) => i.objectId === value.sourceObjectId)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'sourceObjectId must identify an input file',
      });
  });

const text = z.string().max(20_000);
const color = z.string().regex(/^[A-Fa-f0-9]{6}$/);
const scalar = z.union([text, z.number().finite(), z.boolean(), z.null()]);
export const OfficeCellSchema = z.union([
  scalar,
  z
    .object({
      formula: z
        .string()
        .min(1)
        .max(2000)
        .regex(/^=?[^=\s].*$/),
    })
    .strict(),
]);
const table = z
  .object({
    headers: z.array(z.string().max(240)).min(1).max(20),
    rows: z.array(z.array(scalar).max(20)).max(200),
  })
  .strict();

export const OfficeCreateSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('docx'),
      title: z.string().max(240),
      header: z.string().max(500).optional(),
      footer: z.string().max(500).optional(),
      blocks: z
        .array(
          z.discriminatedUnion('type', [
            z
              .object({
                type: z.literal('heading'),
                text,
                level: z
                  .union([z.enum(['1', '2', '3']), z.literal([1, 2, 3])])
                  .default('1'),
              })
              .strict(),
            z
              .object({
                type: z.literal('paragraph'),
                text,
                bold: z.boolean().optional(),
              })
              .strict(),
            z
              .object({
                type: z.literal('bullets'),
                items: z.array(text).min(1).max(100),
              })
              .strict(),
            table.extend({ type: z.literal('table') }),
            z.object({ type: z.literal('page-break') }).strict(),
          ]),
        )
        .min(1)
        .max(300),
    })
    .strict(),
  z
    .object({
      kind: z.literal('xlsx'),
      sheets: z
        .array(
          z
            .object({
              name: z
                .string()
                .min(1)
                .max(31)
                .regex(/^[^\\/[\]*?:]+$/),
              columns: z
                .array(
                  z
                    .object({
                      header: z.string().min(1).max(240),
                      width: z.number().min(5).max(80).optional(),
                      numberFormat: z.string().max(100).optional(),
                    })
                    .strict(),
                )
                .min(1)
                .max(50),
              rows: z.array(z.array(OfficeCellSchema).max(50)).max(5000),
            })
            .strict(),
        )
        .min(1)
        .max(10),
    })
    .strict(),
  z
    .object({
      kind: z.literal('pptx'),
      title: z.string().max(240),
      accentColor: color.default('2563EB'),
      slides: z
        .array(
          z
            .object({
              title: z.string().max(160),
              body: z.array(z.string().max(500)).max(12).optional(),
              table: table.optional(),
              chart: z
                .object({
                  type: z.enum(['bar', 'line', 'pie']),
                  labels: z.array(z.string().max(100)).min(1).max(30),
                  series: z
                    .array(
                      z
                        .object({
                          name: z.string().max(100),
                          values: z.array(z.number().finite()).min(1).max(30),
                        })
                        .strict(),
                    )
                    .min(1)
                    .max(6),
                })
                .strict()
                .optional(),
              notes: z.string().max(5000).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(50),
    })
    .strict(),
]);

export const OfficeEditSchema = z
  .object({
    kind: z.literal('edit'),
    sourceObjectId: z.uuid(),
    sourceChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    changes: z
      .array(
        z.discriminatedUnion('type', [
          z
            .object({
              type: z.literal('replace-text'),
              find: z
                .string()
                .min(1)
                .max(2000)
                .regex(/^[^\r\n\t]+$/),
              replace: z
                .string()
                .max(5000)
                .regex(/^[^\r\n\t]*$/),
              expectedOccurrences: z.number().int().min(1).max(1000),
              // PPTX uses the visible presentation order, not a guessed ZIP filename.
              slide: z.number().int().min(1).max(1000).optional(),
            })
            .strict(),
          z
            .object({
              type: z.literal('set-cell'),
              sheet: z.string().min(1).max(31),
              cell: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}$/),
              value: OfficeCellSchema,
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(200),
  })
  .strict();

export const OfficeExportSchema = z.discriminatedUnion('kind', [
  ...OfficeCreateSchema.options,
  OfficeEditSchema,
]);
export type OfficeCreate = z.infer<typeof OfficeCreateSchema>;
export type OfficeEdit = z.infer<typeof OfficeEditSchema>;
export type OfficeExport = z.infer<typeof OfficeExportSchema>;
export type OfficeCell = z.infer<typeof OfficeCellSchema>;
