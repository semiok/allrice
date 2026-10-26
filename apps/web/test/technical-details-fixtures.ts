// Synthetic records for technical-details-page.tsx. Cloud operations follow
// packages/database/src/cloud-operation-view.ts; changeset runs must pass the
// strict ChangesetRunsResponseSchema the panel parses.

const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = (c: string) => `sha256:${c.repeat(64)}`;
const now = Date.now();
const createdAt = new Date(now - 60_000).toISOString();
const expiresAt = new Date(now + 3_600_000).toISOString();
export const ids = {
  run: id(1),
  user: id(2),
  workspace: id(3),
  session: id(4),
  artifact: id(5),
  doneArtifact: id(6),
  mcpApproval: id(30),
  mcpOperation: id(31),
  partnerApproval: id(35),
  partnerOperation: id(36),
  rejectedOperation: id(37),
  expiredOperation: id(38),
  appFailedOperation: id(39),
  runningRun: id(7),
  runningOperation: id(43),
  succeededOperation: id(32),
  projectOperation: id(33),
  unknownOperation: id(34),
  changesetApproval: id(40),
  changesetOperation: id(41),
};

const task = {
  scope: {
    organizationId: id(10),
    workspaceId: ids.workspace,
    projectId: null,
  },
  chatSessionId: ids.session,
  runId: ids.run,
  rootRunId: ids.run,
  parentRunId: null,
  frozenConfiguration: { employeeVersionId: id(11), digest: digest('a') },
};
const request = (
  approvalId: string,
  binding: unknown,
  expires = expiresAt,
) => ({
  contractVersion: 1,
  direction: 'request',
  kind: 'action_approval',
  requestId: id(Number(approvalId.slice(-2)) + 100),
  version: 1,
  requestDigest: digest('b'),
  task,
  respondentId: ids.user,
  createdAt,
  expiresAt: expires,
  approvalId,
  binding,
});
/** A value that tries to look like a second field on its own line. */
export const forgedNote = '第一行\nchannel：伪装的字段';
export const longText = `报价单已更新，请合作方在周五前确认。${'包括折扣、交付日期和付款方式的说明。'.repeat(8)}`;

const limits = {
  timeoutMs: 30_000,
  outputBytes: 32_768,
  artifactBytes: 1_000_000,
  memoryMiB: 512,
  cpuMillis: 500,
  pids: 64,
};
const evidence = { id: id(67), recordedAt: createdAt, digest: digest('f') };
const cloudBinding = (operationId: string) => ({
  attempt: { operationId },
  execution: { targetId: id(12) },
  task: { runId: ids.run },
});
/** An app call waiting for an answer, or answered with `decision`. */
function appCall(
  operationId: string,
  approvalId: string,
  args: Record<string, unknown>,
  decision?: 'approved' | 'rejected',
  expires = expiresAt,
) {
  return {
    snapshot: {
      status: decision === 'approved' ? 'dispatched' : 'waiting_user',
      binding: cloudBinding(operationId),
      result: null,
    },
    enabled: true,
    mcpAuthorization: { available: true, reason: 'available' },
    proposal: {
      kind: 'mcp',
      endpoint: 'https://api.example-crm.com/mcp',
      tool: 'mcp__app__send_message',
      arguments: args,
      risk: 'external_send',
    },
    approval: {
      request: request(approvalId, {}, expires),
      response: decision ? { decision } : null,
      consumedAt: null,
      revokedAt: null,
    },
    result: null,
  };
}
/** Same tool, different recipients: the cards must differ before approval. */
export function cloudOperations(answered: string[]) {
  const decided = (approvalId: string) =>
    answered.includes(approvalId) ? ('approved' as const) : undefined;
  return [
    appCall(
      ids.mcpOperation,
      ids.mcpApproval,
      {
        channel: 'sales',
        text: '本周报价已更新',
        recipients: [{ email: 'sales@example.com' }],
      },
      decided(ids.mcpApproval),
    ),
    appCall(
      ids.partnerOperation,
      ids.partnerApproval,
      {
        channel: 'partner-ext',
        text: longText,
        notify: true,
        recipients: [{ email: 'buyer@partner.example' }],
        note: forgedNote,
      },
      decided(ids.partnerApproval),
    ),
    appCall(
      ids.rejectedOperation,
      id(44),
      { channel: 'sales', text: '周报' },
      'rejected',
    ),
    appCall(
      ids.expiredOperation,
      id(45),
      { channel: 'sales', text: '周报' },
      undefined,
      new Date(now - 60_000).toISOString(),
    ),
    {
      snapshot: {
        status: 'failed',
        binding: cloudBinding(ids.appFailedOperation),
        result: { status: 'failed', effects: 'none', evidence },
      },
      enabled: true,
      mcpAuthorization: { available: true, reason: 'available' },
      proposal: {
        kind: 'mcp',
        endpoint: 'https://api.example-crm.com/mcp',
        tool: 'mcp__app__send_message',
        arguments: { channel: 'sales', text: '周报' },
        risk: 'external_send',
      },
      approval: null,
      result: {
        code: 'MCP_REMOTE_ERROR_EFFECTS_UNKNOWN',
        output: '{"isError":true,"error":{"message":"channel archived"}}',
        trusted: false,
      },
    },
    {
      snapshot: {
        status: 'succeeded',
        binding: cloudBinding(ids.succeededOperation),
        result: { status: 'succeeded', effects: 'applied', evidence },
      },
      enabled: true,
      mcpAuthorization: null,
      proposal: {
        kind: 'cloud',
        language: 'python',
        script: 'import pandas as pd\nprint(pd.read_csv("sales.csv").sum())',
        inputs: [
          { objectId: id(50), path: 'sales.csv', checksum: digest('c') },
        ],
        outputs: [
          { path: 'summary.xlsx', fileName: '销售汇总.xlsx', format: 'xlsx' },
        ],
        limits,
      },
      approval: null,
      result: { code: 'OK', output: '{"rows": 12}', trusted: false },
    },
    {
      snapshot: {
        status: 'failed',
        binding: cloudBinding(ids.projectOperation),
        result: { status: 'failed', effects: 'none', evidence },
      },
      enabled: true,
      mcpAuthorization: null,
      proposal: {
        kind: 'project',
        project: {
          projectId: id(51),
          snapshot: { kind: 'artifact', id: id(52), version: '1' },
        },
        sourceDigest: digest('d'),
        executable: '/usr/local/bin/node',
        args: ['build.mjs'],
        path: '.',
        files: [{ path: 'build.mjs', objectId: id(53), checksum: digest('e') }],
        preparation: { manager: 'pnpm' },
        outputs: [],
        limits,
      },
      approval: null,
      result: {
        code: 'EXECUTION_FAILED',
        output: 'Error: Cannot find module "vite"',
        trusted: false,
      },
    },
    {
      snapshot: {
        status: 'unknown',
        binding: cloudBinding(ids.unknownOperation),
        result: null,
      },
      enabled: true,
      mcpAuthorization: null,
      proposal: {
        kind: 'cloud',
        language: 'python',
        script:
          'import requests\nrequests.post("https://api.example.com/sync")',
        inputs: [],
        outputs: [],
        network: {
          mode: 'controlled_https',
          origins: ['https://api.example.com'],
        },
        limits,
      },
      approval: null,
      result: null,
    },
  ];
}
/** A call still running, so its card offers to stop the run. */
export const runningOperations = () => [
  {
    snapshot: {
      status: 'running',
      binding: {
        ...cloudBinding(ids.runningOperation),
        task: { runId: ids.runningRun },
      },
      result: null,
    },
    enabled: true,
    mcpAuthorization: { available: true, reason: 'available' },
    proposal: {
      kind: 'mcp',
      endpoint: 'https://api.example-crm.com/mcp',
      tool: 'mcp__app__list_messages',
      arguments: { channel: 'sales' },
      risk: 'read',
    },
    approval: null,
    result: null,
  },
];

const binding = {
  task,
  attempt: {
    operationId: ids.changesetOperation,
    attemptId: id(60),
    attemptNumber: 1,
    generation: 1,
    fence: 1,
  },
  requestedBy: { type: 'user', id: ids.user },
  execution: {
    targetId: id(61),
    targetKind: 'rice_bridge',
    deviceId: id(62),
    grantId: id(63),
    grantVersion: 1,
    scopeDigest: digest('a'),
    workCopy: { id: id(64), kind: 'in_place' },
  },
  action: 'local.fs.changeset',
  policy: { snapshotId: id(65), digest: digest('a') },
  inputDigest: digest('a'),
  dataScope: [],
  baseline: [],
  command: null,
};
const snapshot = (operationId: string, status: string) => ({
  contractVersion: 1,
  binding: { ...binding, attempt: { ...binding.attempt, operationId } },
  stepId: null,
  agentInstanceId: null,
  processId: null,
  cancelRequestId: null,
  idempotencyKey: id(Number(operationId.slice(-2)) + 200),
  status,
  result:
    status === 'succeeded'
      ? {
          status,
          effects: 'applied',
          evidence: { id: id(66), recordedAt: createdAt, digest: digest('f') },
        }
      : null,
});
const payload = (artifactId: string) => ({
  capability: 'local.fs.changeset',
  arguments: {
    path: '.',
    artifactId,
    checksum: digest('9'),
    direction: 'apply',
    files: [
      {
        path: 'README.md',
        before: { text: '旧的说明', checksum: digest('1') },
        after: { text: '新的说明', checksum: digest('2') },
      },
      {
        path: 'notes/todo.md',
        before: null,
        after: { text: '- 整理报价', checksum: digest('3') },
      },
      {
        path: 'docs/plan.md',
        before: { text: '旧计划', checksum: digest('4') },
        after: { text: '新计划', checksum: digest('5') },
      },
    ],
  },
});
/** A run waiting for approval, and a finished one with a lost file result. */
export function changesetRuns(artifactId: string) {
  if (artifactId === ids.artifact)
    return [
      {
        runId: id(70),
        restoreOf: null,
        runState: 'waiting',
        snapshot: snapshot(ids.changesetOperation, 'waiting_user'),
        payload: payload(artifactId),
        approval: {
          request: request(ids.changesetApproval, {
            ...binding,
            task,
          }),
          response: null,
          consumedAt: null,
          revokedAt: null,
        },
        evidence: { result: null, summary: null },
      },
    ];
  return [
    {
      runId: id(71),
      restoreOf: null,
      runState: 'succeeded',
      snapshot: snapshot(id(42), 'succeeded'),
      payload: payload(artifactId),
      approval: null,
      evidence: {
        result: {
          contractVersion: 1,
          files: [
            {
              path: 'README.md',
              status: 'applied',
              beforeChecksum: digest('1'),
              afterChecksum: digest('2'),
            },
            {
              path: 'notes/todo.md',
              status: 'unknown',
              beforeChecksum: null,
              afterChecksum: null,
              errorCode: 'BRIDGE_RESULT_TIMEOUT',
            },
            {
              path: 'docs/plan.md',
              status: 'conflict',
              beforeChecksum: digest('4'),
              afterChecksum: null,
              errorCode: 'WRITE_CONFLICT',
            },
          ],
        },
        summary: null,
      },
    },
  ];
}

export const pendingActions = [
  {
    approvalId: ids.mcpApproval,
    operationId: ids.mcpOperation,
    runId: ids.run,
    expiresAt,
  },
  {
    approvalId: ids.changesetApproval,
    operationId: ids.changesetOperation,
    artifactId: ids.artifact,
    runId: ids.run,
    expiresAt,
  },
];
