import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { ProjectServiceTargetSchema } from './project-service.ts';
const envelope = { version: z.literal(1), id: UuidSchema };
export const ProjectPreviewDataSchema = z
  .object({
    ...envelope,
    type: z.literal('preview.data'),
    data: z
      .string()
      .max(666_668)
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
      ),
    binary: z.boolean().optional(),
  })
  .strict();
export const ProjectPreviewEndSchema = z
  .object({
    ...envelope,
    type: z.literal('preview.end'),
    error: z.boolean().optional(),
  })
  .strict();
export const ProjectPreviewRequestSchema = z
  .object({
    ...envelope,
    type: z.literal('preview.open'),
    target: ProjectServiceTargetSchema,
    request: z
      .object({
        method: z.enum([
          'GET',
          'HEAD',
          'POST',
          'PUT',
          'PATCH',
          'DELETE',
          'OPTIONS',
        ]),
        path: z
          .string()
          .max(4096)
          .refine((v) => v.startsWith('/') && !/[\r\n\0\\]/.test(v)),
        host: z
          .string()
          .max(255)
          .regex(/^[a-z0-9.-]+(?::[0-9]{1,5})?$/),
        headers: z
          .record(z.string().max(128), z.string().max(8192))
          .refine(
            (v) =>
              Object.keys(v).length <= 20 &&
              !Object.values(v).some((s) => /[\r\n\0]/.test(s)),
          ),
        websocket: z.boolean(),
        protocol: z.string().max(128).optional(),
      })
      .strict(),
  })
  .strict();
export const ProjectPreviewResponseSchema = z
  .object({
    ...envelope,
    type: z.literal('preview.response'),
    status: z.number().int().min(101).max(599),
    headers: z
      .record(z.string().max(128), z.string().max(8192))
      .refine(
        (v) =>
          Object.keys(v).length <= 50 &&
          !Object.values(v).some((s) => /[\r\n\0]/.test(s)),
      ),
  })
  .strict();
export const ProjectPreviewServerFrameSchema = z.discriminatedUnion('type', [
  ProjectPreviewRequestSchema,
  ProjectPreviewDataSchema,
  ProjectPreviewEndSchema,
]);
export const ProjectPreviewClientFrameSchema = z.discriminatedUnion('type', [
  ProjectPreviewResponseSchema,
  ProjectPreviewDataSchema,
  ProjectPreviewEndSchema,
]);
export type ProjectPreviewServerFrame = z.infer<
  typeof ProjectPreviewServerFrameSchema
>;
export type ProjectPreviewClientFrame = z.infer<
  typeof ProjectPreviewClientFrameSchema
>;
/** One origin per service; no SaaS or Bridge cookie is forwarded to project code. */
export function projectPreviewHost(serviceId: string, suffix: string) {
  UuidSchema.parse(serviceId);
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+(?::[0-9]{1,5})?$/.test(suffix))
    throw Error('PROJECT_PREVIEW_SUFFIX_INVALID');
  return `rice-preview-${serviceId}.${suffix}`;
}
