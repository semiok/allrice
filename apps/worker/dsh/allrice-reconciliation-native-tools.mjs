import { z } from 'zod';

export const ReconciliationNativeArgumentsSchema = z
  .object({
    artifactId: z.uuid(),
    fileName: z.string().trim().min(1).max(120),
    parentObjectId: z.uuid().optional(),
  })
  .strict();

export const reconciliationNativeTools = [
  {
    canonicalName: 'workspace.reconciliation.export',
    wireName: 'workspace_reconciliation_export',
    description:
      "Create a real XLSX from this Run's confirmed cloud reconciliation JSON artifact using deterministic integer-cent data, not model arithmetic. artifactId is the JSON versionId returned by cloud_process_execute. Returns an immutable workbook and actual downloadUrl to include in the final answer. Optional parentObjectId creates a reviewed version lineage, never overwrites old bytes.",
    timeoutMs: 65000,
    isConcurrencySafe: false,
    validateArguments(args) {
      ReconciliationNativeArgumentsSchema.parse(args);
      return args;
    },
    parameters: {
      artifactId: {
        type: 'string',
        required: true,
        description:
          'UUID versionId of the confirmed cloud reconciliation JSON artifact.',
      },
      fileName: {
        type: 'string',
        required: true,
        description: 'Workbook display filename, 1..120 characters.',
      },
      parentObjectId: {
        type: 'string',
        description:
          'Optional prior XLSX storage object UUID for explicit new-version lineage.',
      },
    },
  },
];
