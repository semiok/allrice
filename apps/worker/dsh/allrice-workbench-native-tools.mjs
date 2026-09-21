// Model-visible native declarations; publication and execution authority stay
// in the Tool Broker. Keep wire enums in parity with its validated definitions.
export const workbenchNativeTools = [
  {
    canonicalName: 'workspace.export.create',
    wireName: 'workspace_export_create',
    description:
      'Create a tenant-private deliverable or reviewable file-change proposal in AllRice managed storage when requested. Publishing a proposal does not write to the local device.',
    presentation: 'tool',
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
        required: true,
        description:
          'Complete final file content, or the changeset JSON proposal.',
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
