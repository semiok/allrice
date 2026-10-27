// Synthetic experience and local command records for the theme browser test.
export const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = (c: string) => `sha256:${c.repeat(64)}`;
export const workspace = id(1),
  failingWorkspace = id(2),
  emptyWorkspace = id(4),
  instance = id(7),
  employee = id(9),
  memory = id(50),
  feedback = id(40);
const at = '2026-10-20T03:00:00.000Z';

export const summary = {
  enabled: true,
  policy: {
    frequency: 'weekly' as const,
    timezone: 'Asia/Shanghai',
    time: '03:00',
    weekday: 1,
    monthDay: 1,
    source: 'company' as const,
    revision: 4,
    validationMode: 'supported_cases' as const,
    adoptionMode: 'supported_private' as const,
  },
  schedule: {
    state: 'scheduled' as const,
    lastCheckedAt: at,
    nextRunAt: '2026-10-27T03:00:00.000Z',
    lastOccurrence: { createdAt: at, outcome: 'drafted' as const },
  },
  counts: { pendingSources: 2, awaitingValidation: 1, adoptedTotal: 3 },
};
const draft = {
  sourceIds: [feedback],
  rule: '月报里的退款单独列一行，再算净回款。',
  reason: '两次反馈都要求把退款单列。',
  applicability: '月度回款报表',
  confidence: 'consistent' as const,
  validation: { kind: 'calculation' as const, check: '含退款的样本复算净回款' },
};
export const adopted = {
  id: id(60),
  runId: id(61),
  instanceId: instance,
  status: 'succeeded' as const,
  state: 'pending_validation' as const,
  revision: 1 as const,
  digest: digest('a'),
  createdAt: at,
  errorCode: null,
  sourceIds: [feedback],
  drafts: [draft],
  adoptions: [
    {
      memoryId: memory,
      draftIndex: 0,
      revision: 1,
      state: 'active' as const,
      reason: null,
      adoptedAt: at,
      recallCount: 2,
    },
  ],
  validations: [],
  validationNotes: [],
  sourceState: 'current' as const,
};
export const unfinished = {
  ...adopted,
  id: id(62),
  runId: id(63),
  status: 'failed' as const,
  state: 'not_ready' as const,
  revision: null,
  digest: null,
  errorCode: 'model_unavailable',
  drafts: [],
  adoptions: [],
  sourceState: undefined,
};
export const candidates = [
  {
    id: feedback,
    content: '下次把退款单独列一行。',
    memoryClass: 'work_note' as const,
    scope: 'private' as const,
    status: 'pending' as const,
    archived: false,
    revision: 1,
    digest: digest('b'),
    source: {
      runId: id(41),
      sessionId: id(42),
      messageId: id(43),
      excerpt: '这份月报的退款混在回款里了，下次单独列出来。',
      digest: digest('c'),
    },
    ownedByMe: true,
    canReview: false,
    createdAt: at,
    reviewedAt: null,
    reviewReason: null,
    originKind: 'incremental' as const,
    instanceId: instance,
  },
  {
    id: id(44),
    content: '周报先写结论，再写过程。',
    memoryClass: 'work_note' as const,
    scope: 'workspace' as const,
    status: 'approved' as const,
    archived: false,
    revision: 2,
    digest: digest('d'),
    source: null,
    ownedByMe: false,
    canReview: false,
    createdAt: at,
    reviewedAt: at,
    reviewReason: '团队统一的写法。',
    instanceId: instance,
  },
];
export const provenance = {
  workspaceId: workspace,
  projection: {
    schemaVersion: 1,
    algorithm: 'validated-rule-v1',
    pin: {
      id: memory,
      revision: 1,
      instanceId: instance,
      contentDigest: digest('e'),
      adoptionDigest: digest('f'),
    },
    topic: 'report_style',
    rule: draft.rule,
    applicability: draft.applicability,
    occurrenceId: id(64),
    draftIndex: 0,
    sourceIds: [feedback],
    sourceDigest: digest('1'),
    outputDigest: digest('2'),
  },
  representation: 'projection',
  indexState: 'current',
  adoptedAt: at,
  consolidationRunId: id(61),
  sources: [
    {
      id: feedback,
      runId: id(41),
      sessionId: id(42),
      messageId: id(43),
      excerpt: '这份月报的退款混在回款里了，下次单独列出来。',
      sourceDigest: digest('3'),
      skills: [],
    },
  ],
};

// Local command operations in each state a person can meet.
const command = {
  executable: '/usr/local/bin/node',
  args: ['scripts/report.mjs', '--month', '2026-10'],
  path: '.',
  files: [{ path: 'data/sales.csv', sha256: digest('4') }],
  imageDigest: digest('5'),
  isolation: 'local-vm-container-v1',
  network: 'none',
  limits: {
    timeoutMs: 60_000,
    outputBytes: 65_536,
    memoryMiB: 512,
    cpuMillis: 1000,
    pids: 64,
  },
};
const result = (exitCode: number, stdout: string, stderr: string) => ({
  backend: 'local-vm-container-v1',
  containerId: 'c'.repeat(64),
  imageDigest: digest('5'),
  stopped: true,
  exitCode,
  reason: 'exited',
  stdout,
  stderr,
  truncated: false,
  workCopy: 'local_isolated_copy',
  sourceDirectoryModified: false,
});
const operation = (n: number, status: string, extra: object) => ({
  snapshot: { status, binding: { attempt: { operationId: id(n) } } },
  command,
  approval: null,
  output: [],
  evidence: null,
  candidateState: null,
  ...extra,
});
export const operations = [
  operation(70, 'waiting_user', {
    approval: {
      request: {
        approvalId: id(71),
        requestId: id(72),
        version: 1,
        requestDigest: digest('6'),
        task: { runId: id(73) },
        respondentId: id(74),
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      response: null,
      revokedAt: null,
    },
  }),
  operation(75, 'running', {
    output: [
      { sequence: 1, stream: 'stdout', content: '读取 data/sales.csv\n' },
      { sequence: 2, stream: 'stderr', content: '第 12 行缺少金额，已跳过\n' },
    ],
  }),
  operation(76, 'succeeded', {
    evidence: {
      summary: '命令已运行完毕，退出码 0。',
      output: result(0, '共 31 行，净回款 128,400 元', ''),
    },
  }),
  operation(77, 'failed', {
    evidence: {
      summary: '命令没有运行成功，退出码 1。',
      output: result(1, '', 'Error: 找不到 data/refunds.csv'),
    },
  }),
];
