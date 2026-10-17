import {
  EmployeeMethodInspectSchema,
  EmployeeMethodPrepareActivationSchema,
  EmployeeMethodActivateSchema,
  EmployeeMethodSaveSchema,
  EmployeeMethodRestoreSchema,
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
const sharedTarget = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scope: { type: 'string', enum: ['department', 'company'], required: true },
    setId: { type: 'string', required: true },
    employeeId: { type: 'string', required: true },
    departmentId: {
      type: 'string',
      description:
        'Required only for scope=department. Omit entirely for scope=company. Echo inspect exactly.',
    },
  },
};

export const employeeMethodNativeTools = [
  {
    canonicalName: 'workspace.employee.method.restore_candidate',
    wireName: 'workspace_employee_method_restore_candidate',
    description:
      'Restore the explicitly requested entire personal, department or company work method to an exact historical version and make it effective immediately. First inspect history, match the version number explicitly named by the direct user to sourceRevisionId, and read current expectedRevision. Shared restore must echo the exact inspected sharedTarget and match the directly requested scope, department and version. A scene-only request requires a partial save instead. A successful restore preserves immutable history and current source permissions, creates a new effective version, and needs no separate testing or activation question. It does not start background work or prove business correctness. Subsequent independent tasks use it; this Run retains its frozen snapshot. Unavailable historical sources remain unavailable. On conflict or uncertainty, read back before retrying.',
    timeoutMs: 15000,
    isConcurrencySafe: false,
    parameters: {
      sharedTarget,
      expectedRevision: { type: 'integer', required: true },
      sourceRevisionId: { type: 'string', required: true },
      changeSummary: { type: 'string', required: true },
    },
    validateArguments: (args) => EmployeeMethodRestoreSchema.parse(args),
  },
  {
    canonicalName: 'workspace.employee.method.prepare_activation',
    wireName: 'workspace_employee_method_prepare_activation',
    description:
      'Prepare confirmation for the exact candidate after its fixed tests pass. For a department or company candidate carry the exact sharedTarget returned by inspect; the server question names the published company employee and exact affected company or department. Never replace that scope disclosure. Pass all relevant testIds, not model claims: every changed/new scene needs current passing evidence; changed common requirements require all current execution-view/scene pairs listed by testCoverage. This never activates. The returned question is server-authored: immediately call native ask_user_question with the returned askUserQuestion argument object verbatim. It already contains one exact question with id, header, question, options and multi_select=false. Never rewrite or summarize it. After the user answers, call activate with the returned receiptId. Do not end the turn between preparation and asking. Expired or changed content requires a fresh preview, not a reused answer.',
    timeoutMs: 15000,
    isConcurrencySafe: false,
    parameters: {
      sharedTarget,
      expectedRevision: { type: 'integer', required: true },
      candidateRevisionId: { type: 'string', required: true },
      candidateDigest: { type: 'string', required: true },
      testIds: { type: 'array', items: { type: 'string' }, required: true },
    },
    validateArguments: (args) =>
      EmployeeMethodPrepareActivationSchema.parse(args),
  },
  {
    canonicalName: 'workspace.employee.method.activate',
    wireName: 'workspace_employee_method_activate',
    description:
      'Activate only the server-prepared candidate explicitly accepted through its native Ask User question. Pass receiptId, never an approval boolean or user text. Server verifies real persisted user answer and adopted proof, current candidate/dependencies/test/authorization. If answer proof is still pending, read/retry this same receipt later without regenerating content or rerunning tests. A duplicate returns its durable result; report enabled and exact version from that result, never infer activation from a yes-like chat phrase. Subsequent independent tasks use the new active version; this task retains its frozen content.',
    timeoutMs: 15000,
    isConcurrencySafe: false,
    parameters: { receiptId: { type: 'string', required: true } },
    validateArguments: (args) => EmployeeMethodActivateSchema.parse(args),
  },
  {
    canonicalName: 'workspace.employee.method.test',
    wireName: 'workspace_employee_method_test',
    description:
      'After an explicit user request to test their candidate, carry sharedTarget unchanged for a department or company candidate; shared tests currently support cny-total-v1 only. Company scene-only tests use the company base; department tests exclude private overlays. Company common tests cover company base and every currently active department shared view, never private content. When inspect returns testCoverage for changed shared common requirements, the user must explicitly request testing those common requirements; echo testCoverage.digest as coverageDigest and test each listed scene separately, including inherited company scenes. Company common coverage also lists executionView per scene: echo that exact view while keeping sharedTarget company; the same scene ID in different views needs distinct evidence. Never omit an affected scene, expand paid testing from a scene-only request, or proceed when testCoverage.valid is false. queue the exact current candidate revision and scene against the server fixed synthetic case: cny-total-v1 checks text-only amounts; cny-file-flow-v1 runs two real isolated file steps (CSV to JSON to summary CSV), checking order and collected file bytes. The latter requires an already authorized cloud environment. Inspect candidate first for revision ID, digest and scene ID. No business files or activation; only the fixed file case writes private synthetic test outputs. Only an explicit user request naming a terminal failed, not_verified test authorizes retryOfTestId: read that exact test first, preserve its frozen candidate/model/case and historical failure. Repeating that parent retry returns the same child; never recursively retry it. Queued does not mean failed: save the test ID, finish this reply to free concurrency, and inspect that same test in a later turn. Never regenerate candidates or resubmit to obtain a pass. Amount assertions are CNY integer cents.',
    timeoutMs: 15000,
    isConcurrencySafe: false,
    parameters: {
      sharedTarget,
      expectedRevision: { type: 'integer', required: true },
      candidateRevisionId: { type: 'string', required: true },
      candidateDigest: { type: 'string', required: true },
      coverageDigest: {
        type: 'string',
        description:
          'Echo inspect candidate testCoverage.digest for shared common requirements; omit when no testCoverage exists.',
      },
      executionView: {
        type: 'object',
        additionalProperties: false,
        description:
          'Only for changed company common requirements. Echo each listed testCoverage.scenes item executionView exactly; sharedTarget stays company.',
        properties: {
          scope: {
            type: 'string',
            enum: ['company', 'department'],
            required: true,
          },
          departmentId: {
            type: 'string',
            description:
              'Only for a listed department execution view; omit for company base.',
          },
        },
      },
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
      'Read the current editable work method, effective content or immutable history. view=candidate is a compatibility name for the editable version, normally identical to the effective version; it is not a user-facing draft stage. Historical unenabled drafts stay in history and are not silently adopted by a new partial save. Default scope=personal. Shared maintenance requires an explicit direct-user company or department request. Use departments to match the explicitly named active department, then inspect with its exact departmentId; selectionRequired or ambiguity needs a direct user selection. Echo the returned sharedTarget and audience, never invent or expand scope. History contains exact version indexes, not source access grants. Preserve scene IDs, omitted fields and exact readable source pins. selectedReferences can be bound only if the user separately requested long-term use. Saving now makes a version effective directly; no separate test or activation is required.',
    timeoutMs: 15000,
    isConcurrencySafe: false,
    parameters: {
      scope: { type: 'string', enum: ['personal', 'department', 'company'] },
      departmentId: {
        type: 'string',
        description:
          'Only with scope=department. Select an exact ID from returned departments when the user names a department. Omit for own-department default. Company maintainers without a department receive selectionRequired and must explicitly select.',
      },
      view: {
        type: 'string',
        required: true,
        enum: ['effective', 'candidate', 'history'],
      },
      beforeRevision: { type: 'integer' },
      beforeTestId: {
        type: 'string',
        description:
          'Candidate test history only: echo nextBeforeTestId to read the next page for this same candidate.',
      },
    },
    validateArguments: (args) => EmployeeMethodInspectSchema.parse(args),
  },
  {
    canonicalName: 'workspace.employee.method.save_candidate',
    wireName: 'workspace_employee_method_save_candidate',
    description:
      "Save and immediately make effective one explicitly requested work-method edit in a single transaction. No separate testing, activation or confirmation question is needed. Default is this user's personal employee. Shared company/department edits need current maintenance authority, the matching direct-user scope and the exact inspected sharedTarget; do not silently change scope. Common requirements require a direct common-edit request, not a single-scene request. Shared file bindings remain unsupported. Inspect view=candidate for expectedRevision first. For existing scenes preserve scene.id; omitted fields and other scenes remain. New scenes need name and appliesWhen. operation=remove_scene removes that scene from effective content on save, preserving history and source files. references append exact readable pins explicitly requested for long-term use. removeReferences unlinks exact knowledge/workflow pins without deleting files. requirements/procedure replace chat-authored text; replaceTextReferences must identify exact current text pins when replacing restored or older sources, creating new versioned text rather than overwriting history. A successful receipt means saved and effective, visible in employee details, used by subsequent independent tasks; this Run keeps its frozen snapshot. Saving changes no tools, network or source permissions, starts no monitoring or background task and does not prove business correctness. If the user requests only discussion or a draft that must not take effect, discuss in chat instead of saving. On conflict or unknown result, read back before retrying.",
    timeoutMs: 15000,
    isConcurrencySafe: false,
    parameters: {
      sharedTarget,
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
      replaceTextReferences: {
        type: 'array',
        items: {
          ...reference,
          properties: {
            ...reference.properties,
            sourceKind: {
              type: 'string',
              required: true,
              enum: ['requirement', 'procedure'],
            },
          },
        },
      },
      changeSummary: { type: 'string', required: true },
    },
    validateArguments: (args) => EmployeeMethodSaveSchema.parse(args),
  },
];
