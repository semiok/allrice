// Model-visible native declarations; publication and execution authority stay
// in the Tool Broker. Keep wire enums in parity with its validated definitions.
import {
  OfficeExportSchema,
  NativeOfficeExportSchema,
} from '@allrice/contracts';

export const workbenchNativeTools = [
  {
    canonicalName: 'workspace.export.create',
    wireName: 'workspace_export_create',
    description:
      'Create a tenant-private deliverable or reviewable file-change proposal in AllRice managed storage when requested. Publishing a proposal does not write to the local device.',
    presentation: 'tool',
    validateArguments(args) {
      if (
        [args.content, args.office, args.python].filter((v) => v !== undefined)
          .length !== 1
      )
        throw new Error(
          'Supply exactly one of content, python or legacy office.',
        );
      if (args.python !== undefined)
        NativeOfficeExportSchema.parse(args.python);
      if (args.office !== undefined) {
        const parsed = OfficeExportSchema.safeParse(args.office);
        if (!parsed.success)
          throw new Error(
            'Invalid Office payload: ' +
              parsed.error.issues
                .slice(0, 5)
                .map(
                  (issue) => `office.${issue.path.join('.')}: ${issue.message}`,
                )
                .join('; '),
          );
      }
    },
    parameters: {
      artifactKind: {
        type: 'string',
        enum: ['document', 'plan', 'changeset'],
        description:
          'document or plan for deliverables; changeset for a file-change proposal in the current authorized Bridge folder. A changeset requires format=json and content={"files":[{"path":"relative/path","before":"original text or null for a new file","after":"new full text or null for deletion"}]}. Read existing content first; at most 32 files. Do not supply device IDs, grants, approvals or checksums: the server binds them. Publishing never executes changes; the user must separately request application and approve the exact action. Plan acceptance is not action authorization.',
      },
      fileName: {
        type: 'string',
        required: true,
        description: 'Human-readable file name.',
      },
      format: {
        type: 'string',
        required: true,
        enum: [
          'markdown',
          'text',
          'html',
          'json',
          'docx',
          'xlsx',
          'pptx',
          'pdf',
        ],
      },
      content: {
        type: 'string',
        description:
          'Complete final text content, or the changeset JSON proposal. Supply exactly one of content, python or legacy office.',
      },
      python: {
        type: 'object',
        additionalProperties: true,
        description:
          'Default Office workflow: {script: "Python code", inputs?: [{path, objectId, checksum}], sourceObjectId?: "edited input UUID"}. Preinstalled python-docx, openpyxl, pandas, python-pptx; no installation needed. Files are /tmp/work/input/<path>; write exactly /tmp/work/output/result.<format>. A fresh isolated workspace per call. Upstream check_office.py runs automatically, followed by formula recalculation, preview and versioned download. Read the Office Skill format guide first. Use native libraries freely for document features; no fixed edit-operation list.',
      },
      office: {
        type: 'object',
        additionalProperties: true,
        description:
          'Compatibility only for previously frozen employee packages. Current Office workflows use python with native document libraries.',
      },
      parentObjectId: {
        type: 'string',
        description:
          'Existing tenant-scoped deliverable object UUID when this file is a revision. Omit when creating the first version.',
      },
      changeSummary: {
        type: 'string',
        description:
          'Short human-readable summary of what changed from the parent version.',
      },
    },
  },
];
