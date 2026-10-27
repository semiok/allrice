import { managedToolWaitTimeoutMs } from './allrice-tool-timeouts.mjs';
import {
  sandboxExecutionParameter,
  sandboxNetworkParameter,
} from './allrice-sandbox-native-parameters.mjs';
import { z } from 'zod';
import {
  SandboxNetworkRequestSchema,
  SandboxExecutionRequestSchema,
} from '@allrice/contracts/native-runtime';

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
    network: SandboxNetworkRequestSchema.optional(),
    execution: SandboxExecutionRequestSchema.optional(),
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
          (value) =>
            value.startsWith('scripts/') && /\.(?:m?js|py)$/.test(value),
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
            parentObjectId: z.uuid().optional(),
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
        message:
          'Frozen script runtime is determined by its verified source; omit language',
      });
    for (const output of value.outputs ?? []) {
      if (
        output.format === 'png' &&
        ((value.language !== 'python' &&
          !value.frozenScript?.path.endsWith('.py')) ||
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
      'Run an exact approved script in the SaaS gVisor sandbox. Offline by default. Only when the platform grants outbound access, network selects exact authorized HTTPS origins through the provided standard proxy; input transfer needs separate authorization. Never bypass a denial or switch execution targets after a failure. Optional execution requests a finite compute/install/build budget; the server freezes its cap and renews only while authorized, without resetting elapsed time. Unsupported executors retain their old limits. Omit language to retain Node 22; language:"python" selects fixed Python 3.11, Matplotlib/Agg, pandas, openpyxl, Pillow and the configured Noto CJK default for Chinese charts. Office libraries are not guaranteed here: use workspace_export_create.python for DOCX/PPTX creation and reopen checks, or workspace_document_read for later inspection. Read only explicitly selected input/ CSV/XLSX copies, treat missing/nonnumeric values explicitly, and save actual output/ PNG bytes with format:"png" and .png path/fileName. The trusted platform decoder validates PNG before returning an immutable objectId/checksum/versionId for native preview/download or embedding through the same Office Skill. Supply exactly one of inline script or frozenScript; frozenScript:{skill,path} retains the original Run-frozen platform Node or private-package Node/Python bytes; omit language because the verified script determines it. Missing dependencies remain an explicit failure; installation grants no execution or network permissions. No AllRice 助手 or host files. Approval binds exact language/script, network destinations, objects/checksums, outputs and limits. A proposal is not execution success; unknown is never replayed. Temporary installs here do not persist into another call; use workspace_project with an exact saved lock and preparation for reusable dependencies. For XLSX, do not trust declared max_row/max_column as populated data. Inspect actual populated XML cells or reset read-only worksheet dimensions, then read bounded ranges in batches; never build a list across a declared million-row sheet. Print a short summary/sample only; write full field maps and tables to declared output files within artifact limits.',
    timeoutMs: managedToolWaitTimeoutMs,
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
      network: sandboxNetworkParameter,
      execution: sandboxExecutionParameter,
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
              'Exact scripts/*.mjs, scripts/*.js, or personal-package scripts/*.py path. The server determines language from the verified source. No package dependencies are installed implicitly.',
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
            parentObjectId: {
              type: 'string',
              description:
                'Optional UUID of the existing deliverable objectId to revise. For PNG/CSV updates, continue the same deliverable series and preserve the declared fileName and format.',
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
    network: SandboxNetworkRequestSchema.optional(),
    execution: SandboxExecutionRequestSchema.optional(),
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
    'Execute Python computation and CJK charts, preferring the ready managed AllRice 助手 in auto mode and using authorized cloud only when local cannot carry the task. Omitted language means Python. location:auto/local/cloud is top-level. Busy/preparing local runtimes wait; explicit local, local-only data and unknown outcomes must never replay in cloud. Reuse fixed Python/Matplotlib/Agg/pandas/openpyxl/Pillow and the configured Noto CJK default. Offline by default and never access host paths. Optional execution requests a finite compute/install/build budget; optional network selects exact public HTTPS origins for automatic backend risk checks. Never ask the user to fill in network settings or addresses. Existing task/input permissions still apply. Per-call installs do not persist; use workspace_project for reusable pinned dependencies. Unsupported controls fail explicitly without changing the target. Do not assume python-docx/python-pptx here; create and reopen Office files within workspace_export_create.python, or inspect existing files with workspace_document_read. Read exact input/ object copies; declare actual output/ PNG/JSON/CSV/TXT files or no files for stdout-only computation. Every successfully returned artifact is already published with immutable objectId/checksum/versionId and can be delivered directly for preview and download. For Markdown, declare a .md fileName with format:txt; it is published as Markdown. Do not copy unchanged artifact content into workspace_export_create merely to republish it or change its presentation. Use an existing artifact reference for delivery, and create a revision only when its content needs to change. Checker-approved PNG bytes can also be embedded through the same Office Skill. Approval binds the exact original call and frozen authority. For XLSX, do not trust declared max_row/max_column as populated data. Inspect actual populated XML cells or reset read-only worksheet dimensions, then read bounded ranges in batches; never build a list across a declared million-row sheet. Print a short summary/sample only; write full field maps and tables to declared output files within artifact limits.',
  timeoutMs: managedToolWaitTimeoutMs,
  isConcurrencySafe: false,
  validateArguments(args) {
    PythonNativeArgumentsSchema.parse(args);
    return args;
  },
  parameters: {
    network: sandboxNetworkParameter,
    execution: sandboxExecutionParameter,
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
        'Required Python script, at most 100000 characters. Read exact input/ files and write declared files under output/. Any network or dependency installation needs the explicit frozen network and execution permissions.',
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
