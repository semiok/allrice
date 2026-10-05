import { z } from 'zod';

// The plain-Node DSH runtime must start before server packages are compiled.
// Keep this tiny wire validator in parity with the Broker's strict DTO schema.
const TechnicalDiagnosticInputSchema = z
  .object({ scope: z.literal('current') })
  .strict();
const checksum = z.string().regex(/^sha256:[a-f0-9]{64}$/);
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
                before: { type: 'string', required: true },
                after: { type: 'string', required: true },
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
