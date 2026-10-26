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
const request = (approvalId: string, binding: unknown) => ({
  contractVersion: 1,
  direction: 'request',
  kind: 'action_approval',
  requestId: id(Number(approvalId.slice(-2)) + 100),
  version: 1,
  requestDigest: digest('b'),
  task,
  respondentId: ids.user,
  createdAt,
  expiresAt,
  approvalId,
  binding,
});

const limits = {
  timeoutMs: 30_000,
  outputBytes: 32_768,
  artifactBytes: 1_000_000,
  memoryMiB: 512,
  cpuMillis: 500,
  pids: 64,
};
const cloudBinding = (operationId: string) => ({
  attempt: { operationId },
  execution: { targetId: id(12) },
  task: { runId: ids.run },
});
/** Pending, finished, not finished and unconfirmed: one card each. */
export function cloudOperations(approved: boolean) {
  return [
    {
      snapshot: {
        status: approved ? 'dispatched' : 'waiting_user',
        binding: cloudBinding(ids.mcpOperation),
        result: null,
      },
      enabled: true,
      mcpAuthorization: { available: true, reason: 'available' },
      proposal: {
        kind: 'mcp',
        endpoint: 'https://api.example-crm.com/mcp',
        tool: 'mcp__crm__send_message',
        arguments: { channel: 'sales', text: '本周报价已更新' },
        risk: 'external_send',
      },
      approval: {
        request: request(ids.mcpApproval, {}),
        response: approved ? { decision: 'approved' } : null,
        consumedAt: null,
        revokedAt: null,
      },
      result: null,
    },
    {
      snapshot: {
        status: 'succeeded',
        binding: cloudBinding(id(32)),
        result: { status: 'succeeded', effects: 'applied' },
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
        binding: cloudBinding(id(33)),
        result: { status: 'failed', effects: 'none' },
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
        binding: cloudBinding(id(34)),
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
