// Model-visible native declarations; publication and execution authority stay
// in the Tool Broker. Keep wire enums in parity with its validated definitions.
import { OfficeExportSchema } from '@allrice/contracts';

export const workbenchNativeTools = [
  {
    canonicalName: 'workspace.export.create',
    wireName: 'workspace_export_create',
    description:
      'Create a tenant-private deliverable or reviewable file-change proposal in AllRice managed storage when requested. Publishing a proposal does not write to the local device.',
    presentation: 'tool',
    validateArguments(args) {
      if ((args.content !== undefined) === (args.office !== undefined))
        throw new Error('Supply exactly one of content or office.');
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
          'Complete final text content, or the changeset JSON proposal. Supply exactly one of content or office.',
      },
      office: {
        type: 'object',
        additionalProperties: true,
        description:
          'Structured Office payload instead of content. Read the Office Skill references for complete schemas. Create kind=docx with title and blocks, kind=xlsx with sheets (typed cells and formulas), or kind=pptx with title and slides (native tables/charts/notes). To preserve an uploaded template, use kind=edit with sourceObjectId, sourceChecksum and changes returned/guided by workspace_document_read(includeStructure=true); changes are replace-text or set-cell. The Broker validates the complete discriminated payload and preserves the original file.',
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
