import { z } from 'zod';
import { CloudCommandInputSchema } from './runtime-v2/cloud-command.ts';
import { UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';

/** Convert the exact authorized Office object through DSH, never a client path. */
export const OfficePdfExportSchema = z
  .object({ objectId: UuidSchema, checksum: ChecksumSchema })
  .strict();

/** DSH's native Python Office workflow; Allrice only supplies files/runtime. */
export const NativeOfficeExportSchema = z
  .object({
    script: CloudCommandInputSchema.shape.script,
    inputs: CloudCommandInputSchema.shape.inputs,
    sourceObjectId: z
      .uuid()
      .nullish()
      .describe('修改输入文件时填写其 objectId；新文件省略或传 null。'),
    // Compatibility for model-authored export metadata. Execution still uses
    // only script/inputs; the delivery adapter stores this as version metadata.
    changeSummary: z.string().max(2000).nullish(),
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
