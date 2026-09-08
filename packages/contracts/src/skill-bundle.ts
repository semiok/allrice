import { z } from 'zod';

const checksum = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const SkillResourcePathSchema = z
  .string()
  .max(240)
  .regex(
    /^(?:references|assets|scripts)\/[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/,
  )
  .refine(
    (value) => !value.split('/').some((part) => part === '.' || part === '..'),
  );

export const SkillBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    checksum,
    contentChecksum: checksum,
    sourceRef: z.string().url().max(1000),
    license: z.string().trim().min(1).max(120),
    reviewedBy: z.string().trim().min(1).max(240),
    resources: z
      .array(
        z
          .object({
            path: SkillResourcePathSchema,
            mediaType: z
              .string()
              .regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/)
              .max(120),
            byteLength: z.number().int().min(0).max(131072),
            checksum,
            // Small immutable package assets only. Large user artifacts stay in StoragePort.
            contentBase64: z
              .string()
              .max(174764)
              .regex(
                /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
              ),
          })
          .strict(),
      )
      .max(32),
    dependencies: z
      .array(
        z.discriminatedUnion('kind', [
          z
            .object({
              kind: z.literal('tool'),
              name: z
                .string()
                .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)
                .max(160),
            })
            .strict(),
          z
            .object({
              kind: z.literal('runtime'),
              name: z.literal('node'),
              version: z.literal('22.23.2'),
              imageDigest: checksum,
            })
            .strict(),
        ]),
      )
      .max(32),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    if (bundle.resources.reduce((sum, r) => sum + r.byteLength, 0) > 524288)
      ctx.addIssue({ code: 'custom', message: 'skill_bundle_too_large' });
    const paths = bundle.resources.map((r) => r.path.toLowerCase());
    if (new Set(paths).size !== paths.length)
      ctx.addIssue({ code: 'custom', message: 'skill_bundle_duplicate_path' });
    if (
      bundle.dependencies.length !==
      new Set(bundle.dependencies.map((d) => `${d.kind}:${d.name}`)).size
    )
      ctx.addIssue({
        code: 'custom',
        message: 'skill_bundle_duplicate_dependency',
      });
  });
export type SkillBundle = z.infer<typeof SkillBundleSchema>;
