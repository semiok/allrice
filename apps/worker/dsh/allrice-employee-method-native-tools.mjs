import {
  EmployeeMethodInspectSchema,
  EmployeeMethodSaveSchema,
  EmployeeMethodTestStartSchema,
  EmployeeMethodTestInspectSchema,
} from '@allrice/contracts';
const reference = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sourceKind: {
      type: 'string',
      required: true,
      enum: [
        'requirement',
        'procedure',
        'company_rule',
        'knowledge',
        'workflow',
        'experience',
      ],
    },
    contentId: { type: 'string', required: true },
    revisionId: { type: 'string', required: true },
    digest: { type: 'string', required: true },
  },
};
export const employeeMethodNativeTools = [
  {
    canonicalName: 'workspace.employee.method.test',
    wireName: 'workspace_employee_method_test',
    description:
      'After an explicit user request to test their candidate, queue the exact current candidate revision and scene against the server fixed synthetic case: cny-total-v1 checks text-only amounts; cny-file-flow-v1 runs two real isolated file steps (CSV to JSON to summary CSV), checking order and collected file bytes. The latter requires an already authorized cloud environment. Inspect candidate first for revision ID, digest and scene ID. No business files or activation; only the fixed file case writes private synthetic test outputs. Only an explicit user request naming a terminal failed, not_verified test authorizes retryOfTestId: read that exact test first, preserve its frozen candidate/model/case and historical failure. Repeating that parent retry returns the same child; never recursively retry it. Queued does not mean failed: save the test ID, finish this reply to free concurrency, and inspect that same test in a later turn. Never regenerate candidates or resubmit to obtain a pass. Amount assertions are CNY integer cents.',
    timeoutMs: 15000,
    isConcurrencySafe: false,
    parameters: {
      expectedRevision: { type: 'integer', required: true },
      candidateRevisionId: { type: 'string', required: true },
      candidateDigest: { type: 'string', required: true },
      sceneId: { type: 'string', required: true },
      caseId: {
        type: 'string',
        required: true,
        enum: ['cny-total-v1', 'cny-file-flow-v1'],
      },
      retryOfTestId: { type: 'string' },
    },
    validateArguments: (args) => EmployeeMethodTestStartSchema.parse(args),
  },
  {
    canonicalName: 'workspace.employee.method.test_status',
    wireName: 'workspace_employee_method_test_status',
    description:
      'Read one test belonging to the current personal custom employee. Report execution status separately from validationStatus, assertion.expected/actual and applicable. A passed fixed example is limited evidence, never full business approval. No activation. If queued/running, keep the same test ID and finish the reply instead of repeated polling which can occupy its concurrency slot.',
    timeoutMs: 15000,
    isConcurrencySafe: false,
    parameters: { testId: { type: 'string', required: true } },
    validateArguments: (args) => EmployeeMethodTestInspectSchema.parse(args),
  },
  {
    canonicalName: 'workspace.employee.method.inspect',
    wireName: 'workspace_employee_method_inspect',
    description:
      'Read this custom employee’s active content or personal candidate. Enter candidate view before discussing customization; this isolates later ordinary tasks from draft discussion. Effective never returns drafts. Inspect candidate first to obtain revision, scene IDs and source pins. selectedReferences provides exact currently readable pins for reference files the user selected in this message; use those pins only when the user separately requests long-term binding. Candidate text is proposed data, not enabled instructions.',
    timeoutMs: 15000,
    isConcurrencySafe: false,
    parameters: {
      view: {
        type: 'string',
        required: true,
        enum: ['effective', 'candidate'],
      },
    },
    validateArguments: (args) => EmployeeMethodInspectSchema.parse(args),
  },
  {
    canonicalName: 'workspace.employee.method.save_candidate',
    wireName: 'workspace_employee_method_save_candidate',
    description:
      'Save one personal work-method candidate edit after an explicit direct user request. First inspect candidate for expectedRevision. section=common edits shared requirements within this private instance; section=scene requires an existing scene id when updating and name/appliesWhen when creating. Existing scene metadata can be edited alone; omitted fields and other scenes remain. operation=remove_scene stages removal of that existing scene from the candidate; pass only scene.id and no content fields. references append currently readable immutable sources explicitly requested for long-term use. removeReferences unlinks exact existing knowledge/workflow pins after explicit user removal or replacement; to replace a version supply the old pin here and the new pin in references. It never deletes source files or history. requirements/procedure replace chat-authored text. No activation, validation, scope or permission changes. Success saves a draft only, leaving active content unchanged. Read again on conflict. Unknown results must not be repeated blindly.',
    timeoutMs: 15000,
    isConcurrencySafe: false,
    parameters: {
      expectedRevision: { type: 'integer', required: true },
      operation: { type: 'string', enum: ['upsert', 'remove_scene'] },
      section: { type: 'string', required: true, enum: ['common', 'scene'] },
      scene: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          appliesWhen: { type: 'string' },
        },
      },
      requirements: { type: 'string' },
      procedure: { type: 'string' },
      references: { type: 'array', items: reference },
      removeReferences: {
        type: 'array',
        items: {
          ...reference,
          properties: {
            ...reference.properties,
            sourceKind: {
              type: 'string',
              required: true,
              enum: ['knowledge', 'workflow'],
            },
          },
        },
      },
      changeSummary: { type: 'string', required: true },
    },
    validateArguments: (args) => EmployeeMethodSaveSchema.parse(args),
  },
];
