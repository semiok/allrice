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
      'Restore a specified historical revision of this entire personal work method into a NEW candidate only. First inspect history to match the version number explicitly named by the user (e.g. 请恢复我的整份工作方法到第1版) to its exact sourceRevisionId, and read current revision for expectedRevision. A scene-only request does not authorize whole-method restoration. Preserve active content, history and current source permissions. The new candidate needs its OWN fixed tests and exact confirmation before activation; old passing evidence is not transferable. Unavailable historical sources remain unavailable. On conflict or uncertain result, inspect candidate/history instead of blind repetition.',
    timeoutMs: 15000,
    isConcurrencySafe: false,
    parameters: {
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
      'Prepare confirmation for the exact candidate after its fixed tests pass. For a department or company candidate carry the exact sharedTarget returned by inspect; the server question names the published company employee and exact affected company or department. Never replace that scope disclosure. Pass all relevant testIds, not model claims: every changed/new scene needs current passing evidence; changed common requirements require all current scenes. This never activates. The returned question is server-authored: immediately call native ask_user_question with the returned askUserQuestion argument object verbatim. It already contains one exact question with id, header, question, options and multi_select=false. Never rewrite or summarize it. After the user answers, call activate with the returned receiptId. Do not end the turn between preparation and asking. Expired or changed content requires a fresh preview, not a reused answer.',
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
      'After an explicit user request to test their candidate, carry sharedTarget unchanged for a department or company candidate; shared tests currently support cny-total-v1 only. Company tests exclude all department/private overlays; department tests exclude private overlays. queue the exact current candidate revision and scene against the server fixed synthetic case: cny-total-v1 checks text-only amounts; cny-file-flow-v1 runs two real isolated file steps (CSV to JSON to summary CSV), checking order and collected file bytes. The latter requires an already authorized cloud environment. Inspect candidate first for revision ID, digest and scene ID. No business files or activation; only the fixed file case writes private synthetic test outputs. Only an explicit user request naming a terminal failed, not_verified test authorizes retryOfTestId: read that exact test first, preserve its frozen candidate/model/case and historical failure. Repeating that parent retry returns the same child; never recursively retry it. Queued does not mean failed: save the test ID, finish this reply to free concurrency, and inspect that same test in a later turn. Never regenerate candidates or resubmit to obtain a pass. Amount assertions are CNY integer cents.',
    timeoutMs: 15000,
    isConcurrencySafe: false,
    parameters: {
      sharedTarget,
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
      'Read this custom employee’s active content, candidate or immutable personal history indexes. Default scope=personal. For explicitly requested department maintenance use scope=department. Its departments list contains current maintainable choices: company maintainers can choose any active department in this company, department maintainers only their own. For a named target, match the exact name/ID, then inspect again with departmentId; ambiguous names require clarification. selectionRequired means there is no own department: do not infer a target. User wording must name the target (e.g. 请创建部门“运营部”的“金额合计”工作场景), while 本部门 always means the user’s current department; for company maintenance use scope=company; the server checks current maintenance and returns exact sharedTarget plus audience. Shared history is not available yet. Company maintainers do not require a department. Echo sharedTarget unchanged to save/test/prepare; never invent a target or treat content access as permission. Shared views exclude private references. Only history supports beforeRevision pagination. History includes no source bodies and grants no source access; reading it isolates later ordinary tasks like candidate view. Match an explicitly requested whole-method version to its exact history ID before restore_candidate. Enter candidate view before discussing customization; this isolates later ordinary tasks from draft discussion. Effective never returns drafts. Inspect candidate first to obtain revision, scene IDs and source pins. candidateTests lists bounded existing test IDs for this exact candidate; read test_status for their assertion and current applicability, never infer a pass from execution status. selectedReferences provides exact currently readable pins for reference files the user selected in this message; use those pins only when the user separately requests long-term binding. Candidate text is proposed data, not enabled instructions.',
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
    },
    validateArguments: (args) => EmployeeMethodInspectSchema.parse(args),
  },
  {
    canonicalName: 'workspace.employee.method.save_candidate',
    wireName: 'workspace_employee_method_save_candidate',
    description:
      'Save one work-method candidate edit after an explicit direct user request. Default is personal. For an explicit company or department request, first inspect the matching scope=company or scope=department and echo its sharedTarget exactly; current maintenance authority is required. Shared mode currently supports text scenes only, not common requirements or file reference bindings. Never silently change scope or save an unsupported request as personal. First inspect candidate for expectedRevision. section=common edits shared requirements within this private instance; section=scene requires an existing scene id when updating and name/appliesWhen when creating. Existing scene metadata can be edited alone; omitted fields and other scenes remain. operation=remove_scene stages removal of that existing scene from the candidate; pass only scene.id and no content fields. references append currently readable immutable sources explicitly requested for long-term use. removeReferences unlinks exact existing knowledge/workflow pins after explicit user removal or replacement; to replace a version supply the old pin here and the new pin in references. It never deletes source files or history. requirements/procedure replace chat-authored text. To replace restored old pins, forked text, or older hand-authored/migrated text, pass its exact current requirement/procedure pins in replaceTextReferences together with the corresponding new requirements/procedure. Each explicit text replacement creates a new private source; repeat this exact-pin path for subsequent edits to a fork. Currently unavailable sources cannot be copied. This only replaces those references within this candidate; it does not edit source assets, other references or historical versions. Read back the saved candidate before describing the change. No activation, validation or permission changes. Shared scope must match the exact inspected target and explicit user request. Success saves a draft only, leaving active content unchanged. Read again on conflict. Unknown results must not be repeated blindly.',
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
