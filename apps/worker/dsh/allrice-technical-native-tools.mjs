import { z } from 'zod';

// The plain-Node DSH runtime must start before server packages are compiled.
// Keep this tiny wire validator in parity with the Broker's strict DTO schema.
const TechnicalDiagnosticInputSchema = z
  .object({ scope: z.literal('current') })
  .strict();
const checksum = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const reviewCandidate = z
  .object({ artifactId: z.string().uuid(), digest: checksum })
  .strict();
export const reviewNativeInputSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('inspect'),
      candidate: reviewCandidate.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('review'),
      candidate: reviewCandidate,
      evidence: z
        .object({
          kind: z.literal('repository_ci'),
          subjectId: z.string().uuid(),
          evidenceDigest: checksum,
        })
        .strict(),
      verdict: z.enum(['accept', 'revise']),
      summary: z.string().trim().min(1).max(16000),
    })
    .strict(),
  z
    .object({
      action: z.literal('deliver'),
      candidate: reviewCandidate,
      reviewId: z.string().uuid(),
    })
    .strict(),
]);
export const repairNativeInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }).strict(),
  z
    .object({
      action: z.literal('apply'),
      expectedCandidate: checksum,
      proposal: z
        .object({
          files: z
            .array(
              z
                .object({
                  path: z
                    .string()
                    .max(1024)
                    .refine(
                      (p) =>
                        p.length > 0 &&
                        !p.startsWith('/') &&
                        !/[\\:]/u.test(p) &&
                        Array.from(p).every(
                          (c) =>
                            c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127,
                        ) &&
                        p
                          .split('/')
                          .every(
                            (part) =>
                              part !== '' && part !== '.' && part !== '..',
                          ),
                    ),
                  before: z.string().max(200000).nullable(),
                  after: z.string().max(200000).nullable(),
                })
                .strict(),
            )
            .min(1)
            .max(32),
        })
        .strict(),
    })
    .strict(),
  z
    .object({ action: z.literal('verify'), candidateChecksum: checksum })
    .strict(),
]);

// Private platform kernel only. This declaration is not an employee capability.
export const technicalNativeTools = [
  {
    canonicalName: 'platform.repository.review',
    wireName: 'platform_repository_review',
    isConcurrencySafe: false,
    presentation: 'tool',
    description:
      'Inspect the frozen repository candidate, record its independent review opinion, or seal its accepted delivery. No edits, execution, network or repository writes.',
    parameters: {
      action: {
        type: 'string',
        enum: ['inspect', 'review', 'deliver'],
        required: true,
      },
      candidate: {
        type: 'object',
        additionalProperties: false,
        description:
          'Exact candidate reference returned by inspect; required for review and deliver.',
        properties: {
          artifactId: { type: 'string', required: true },
          digest: { type: 'string', required: true },
        },
      },
      evidence: {
        type: 'object',
        additionalProperties: false,
        description: 'Exact evidence returned by inspect; required for review.',
        properties: {
          kind: { type: 'string', enum: ['repository_ci'], required: true },
          subjectId: { type: 'string', required: true },
          evidenceDigest: { type: 'string', required: true },
        },
      },
      verdict: { type: 'string', enum: ['accept', 'revise'] },
      summary: {
        type: 'string',
        description:
          'Review opinion, 1 to 16000 characters; required for review.',
      },
      reviewId: {
        type: 'string',
        description:
          'Accepted opinion ID returned by review; required for deliver.',
      },
    },
    validateArguments: (args) => reviewNativeInputSchema.parse(args),
  },
  {
    canonicalName: 'platform.repository.repair',
    wireName: 'platform_repository_repair',
    isConcurrencySafe: false,
    presentation: 'tool',
    timeoutMs: 180000,
    description:
      'Read the current registered private AllRice candidate, apply exact complete before/after text with expectedCandidate, or verify an exact candidateChecksum using the immutable assertions. This tool is restricted to this platform repair Run. Only the designated product file can change, at most three candidates. No command, path, repository URL, assertion change, dependency installation, main write or deployment can be requested. Repeated verification reads the same operation and never reruns uncertain work.',
    parameters: {
      action: {
        type: 'string',
        enum: ['read', 'apply', 'verify'],
        required: true,
      },
      expectedCandidate: { type: 'string' },
      candidateChecksum: { type: 'string' },
      proposal: {
        type: 'object',
        additionalProperties: false,
        properties: {
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                before: {
                  oneOf: [{ type: 'string' }, { type: 'null' }],
                  required: true,
                },
                after: {
                  oneOf: [{ type: 'string' }, { type: 'null' }],
                  required: true,
                },
              },
            },
          },
        },
      },
    },
    validateArguments: (args) => repairNativeInputSchema.parse(args),
  },
  {
    canonicalName: 'platform.technical.diagnostics',
    wireName: 'platform_technical_diagnostics',
    isConcurrencySafe: true,
    presentation: 'tool',
    description:
      'Read bounded current AllRice platform health, queue pressure, recent record references and the task-linked issue. The platform selects all scopes; no host URL, path, SQL or arbitrary command is accepted. Unknown or stale samples are not evidence of failure. Use receipt IDs and observed times for claims; this tool cannot repair or deploy.',
    parameters: {
      scope: { type: 'string', enum: ['current'], required: true },
    },
    validateArguments: (args) => TechnicalDiagnosticInputSchema.parse(args),
  },
];
