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
    language: z.enum(['javascript', 'python']).optional(),
    script: z
      .string()
      .min(1)
      .max(100000)
      .refine((value) => !value.includes('\0'))
      .optional(),
    frozenScript: z
      .object({
        skill: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
        path: path.refine(
          (value) => value.startsWith('scripts/') && /\.m?js$/.test(value),
        ),
      })
      .strict()
      .optional(),
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
            format: z.enum(['json', 'csv', 'txt', 'png']),
          })
          .strict(),
      )
      .max(8)
      .optional(),
    limits: limits.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.script === undefined) === (value.frozenScript === undefined))
      ctx.addIssue({
        code: 'custom',
        message: 'Exactly one of script or frozenScript is required',
      });
    if (value.language !== undefined && value.frozenScript !== undefined)
      ctx.addIssue({
        code: 'custom',
        message: 'Frozen scripts retain their Node runtime',
      });
    for (const output of value.outputs ?? []) {
      if (
        output.format === 'png' &&
        (value.language !== 'python' ||
          !output.path.toLowerCase().endsWith('.png') ||
          !output.fileName.toLowerCase().endsWith('.png'))
      )
        ctx.addIssue({
          code: 'custom',
          message: 'PNG requires Python and .png names',
        });
    }
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
      'Run an exact approved script in the existing no-network SaaS gVisor sandbox. Omit language to retain Node 22; language:"python" selects fixed Python 3.11, Matplotlib/Agg, pandas, openpyxl, Pillow and Noto CJK fonts for Chinese charts. Read only explicitly selected input/ CSV/XLSX copies, treat missing/nonnumeric values explicitly, and save actual output/ PNG bytes with format:"png" and .png path/fileName. The trusted platform decoder validates PNG before returning an immutable objectId/checksum/versionId for native preview/download or embedding through the same Office Skill. Supply exactly one of inline script or frozenScript; frozenScript:{skill,path} retains the original Run-frozen Node bytes. No Bridge, host files or network access. Approval binds exact language/script, objects/checksums, outputs and limits. A proposal is not execution success.',
    timeoutMs: 180000,
    isConcurrencySafe: false,
    validateArguments(args) {
      CloudNativeArgumentsSchema.parse(args);
      return args;
    },
    parameters: {
      language: {
        type: 'string',
        enum: ['javascript', 'python'],
        description:
          'Optional runtime for inline script. Omit to preserve Node; use python for CJK charts. Frozen script references stay Node.',
      },
      script: {
        type: 'string',
        description:
          'Inline JavaScript ES module or Python selected by language, at most 100000 characters. Read input/ copies; write declared files beneath output/. Omit when using frozenScript.',
      },
      frozenScript: {
        type: 'object',
        additionalProperties: false,
        description:
          'Preferred for a frozen Skill: server resolves original bytes/version/hash from this Run; no manual script copying. Mutually exclusive with script.',
        properties: {
          skill: { type: 'string', required: true },
          path: {
            type: 'string',
            required: true,
            description:
              'scripts/*.mjs or scripts/*.js bundle path, e.g. scripts/reconcile.mjs.',
          },
        },
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
              enum: ['json', 'csv', 'txt', 'png'],
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

// Canonical Python retains the existing bounded command shape and raw call.
export const PythonNativeArgumentsSchema = z
  .object({
    language: z.literal('python').optional(),
    script: CloudNativeArgumentsSchema.shape.script.unwrap(),
    inputs: CloudNativeArgumentsSchema.shape.inputs,
    outputs: CloudNativeArgumentsSchema.shape.outputs,
    limits: CloudNativeArgumentsSchema.shape.limits,
    location: z.enum(['auto', 'local', 'cloud']).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const { location: _location, ...command } = value;
    void _location;
    const result = CloudNativeArgumentsSchema.safeParse({
      ...command,
      language: 'python',
    });
    if (!result.success)
      for (const issue of result.error.issues)
        ctx.addIssue({
          code: 'custom',
          path: issue.path,
          message: issue.message,
        });
  });
const cloud = cloudNativeTools[0];
cloudNativeTools.push({
  canonicalName: 'python.execute',
  wireName: 'python_execute',
  description:
    'Execute Python computation and CJK charts, preferring the ready managed Bridge in auto mode and using authorized cloud only when local cannot carry the task. Omitted language means Python. location:auto/local/cloud is top-level. Busy/preparing local runtimes wait; explicit local, local-only data and unknown outcomes must never replay in cloud. Reuse fixed Python/Matplotlib/Agg/pandas/openpyxl/Pillow/Noto CJK, without installing dependencies, network access or host paths. Read exact input/ object copies; declare actual output/ PNG/JSON/CSV/TXT files or no files for stdout-only computation. Real checker-approved PNG bytes return immutable objectId/checksum/versionId for preview, download and embedding through the same Office Skill. Approval binds the exact original call and frozen authority.',
  timeoutMs: 180000,
  isConcurrencySafe: false,
  validateArguments(args) {
    PythonNativeArgumentsSchema.parse(args);
    return args;
  },
  parameters: {
    language: {
      type: 'string',
      enum: ['python'],
      description:
        'Optional. Omit to use Python; JavaScript and frozenScript are not supported by this canonical tool.',
    },
    script: {
      ...cloud.parameters.script,
      required: true,
      description:
        'Required Python script, at most 100000 characters. Read exact input/ files, write declared files under output/; no dependency installation.',
    },
    inputs: cloud.parameters.inputs,
    outputs: {
      ...cloud.parameters.outputs,
      description:
        'Zero to eight declared PNG/JSON/CSV/TXT files under output/. Empty or omitted outputs returns bounded stdout without inventing a file.',
    },
    limits: cloud.parameters.limits,
    location: {
      type: 'string',
      enum: ['auto', 'local', 'cloud'],
      description:
        'Optional, defaults to auto. Prefer actual ready local; local requires local execution and never falls back to cloud. cloud explicitly chooses the authorized cloud runtime.',
    },
  },
});
