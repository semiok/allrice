import { TechnicalDiagnosticInputSchema } from '@allrice/database/technical-contracts';

// Private platform kernel only. This declaration is not an employee capability.
export const technicalNativeTools = [
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
