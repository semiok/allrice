import { z } from 'zod';

// The DSH DSL projects shape only. These bounds run before JSON-RPC; the
// production Broker repeats its authoritative schema, tenant and approval checks.
const path = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      ![...value].some((char) => char.charCodeAt(0) < 32) &&
      value.split('/').every((part) => part && part !== '.' && part !== '..'),
  );
const limits = z
  .object({
    timeoutMs: z.number().int().min(500).max(60000).optional(),
    outputBytes: z.number().int().min(1024).max(65536).optional(),
    artifactBytes: z.number().int().min(1024).max(4000000).optional(),
    memoryMiB: z.number().int().min(128).max(512).optional(),
    cpuMillis: z.number().int().min(100).max(1000).optional(),
    pids: z.literal(64).optional(),
  })
  .strict();
export const CloudNativeArgumentsSchema = z
  .object({
    script: z
      .string()
      .min(1)
      .max(100000)
      .refine((value) => !value.includes('\0')),
    inputs: z
      .array(
        z
          .object({
            path,
            objectId: z.uuid(),
            checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(16)
      .optional(),
    outputs: z
      .array(
        z
          .object({
            path,
            fileName: z
              .string()
              .min(1)
              .max(120)
              .refine(
                (value) =>
                  ![...value].some(
                    (char) =>
                      char.charCodeAt(0) < 32 || char === '/' || char === '\\',
                  ),
              ),
            format: z.enum(['json', 'csv', 'txt']),
          })
          .strict(),
      )
      .max(8)
      .optional(),
    limits: limits.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const files of [value.inputs ?? [], value.outputs ?? []]) {
      const paths = files.map((file) => file.path);
      if (
        new Set(paths).size !== paths.length ||
        paths.some((p) => paths.some((q) => p.startsWith(`${q}/`)))
      )
        ctx.addIssue({
          code: 'custom',
          message: 'duplicate or overlapping cloud paths',
        });
    }
    const ids = (value.inputs ?? []).map((file) => file.objectId);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', message: 'duplicate cloud object' });
  });

export const cloudNativeTools = [
  {
    canonicalName: 'cloud.process.execute',
    wireName: 'cloud_process_execute',
    description:
      'Propose and await exact approval to run a Node 22 script in a no-network SaaS gVisor sandbox. Only explicitly selected uploaded object copies are inputs; no Bridge or host access. Approval binds exact script, objects/checksums, output files and limits. Returned artifact versionId is not a local path. A proposal is not execution success.',
    timeoutMs: 180000,
    isConcurrencySafe: false,
    validateArguments(args) {
      CloudNativeArgumentsSchema.parse(args);
      return args;
    },
    parameters: {
      script: {
        type: 'string',
        required: true,
        description:
          'Exact JavaScript ES module, at most 100000 characters. For a Skill task use its frozen script without rewriting it.',
      },
      inputs: {
        type: 'array',
        description:
          'At most 16 uploaded input objects; paths are relative to /tmp/work/input.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            objectId: { type: 'string', required: true },
            checksum: {
              type: 'string',
              required: true,
              description: 'sha256:<64 lowercase hex>',
            },
          },
        },
      },
      outputs: {
        type: 'array',
        description:
          'At most 8 output files, relative to /tmp/work/output. Include a user-facing fileName and format.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            fileName: { type: 'string', required: true },
            format: {
              type: 'string',
              required: true,
              enum: ['json', 'csv', 'txt'],
            },
          },
        },
      },
      limits: {
        type: 'object',
        additionalProperties: false,
        description:
          'Optional bounded resource limits; omitting uses server defaults.',
        properties: {
          timeoutMs: { type: 'integer', description: '500..60000 ms' },
          outputBytes: { type: 'integer', description: '1024..65536 bytes' },
          artifactBytes: {
            type: 'integer',
            description: '1024..4000000 bytes',
          },
          memoryMiB: { type: 'integer', description: '128..512 MiB' },
          cpuMillis: { type: 'integer', description: '100..1000' },
          pids: { type: 'integer', enum: [64] },
        },
      },
    },
  },
];
