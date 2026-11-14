// Synthetic local command and MCP records for current UI browser tests.
export const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = (c: string) => `sha256:${c.repeat(64)}`;
export const workspace = id(1),
  instance = id(7),
  employee = id(9);

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
const approval = (n: number) => ({
  request: {
    approvalId: id(n),
    requestId: id(n + 1),
    version: 1,
    requestDigest: digest('6'),
    task: { runId: id(73) },
    respondentId: id(74),
    expiresAt: '2099-01-01T00:00:00.000Z',
  },
  response: null,
  revokedAt: null,
});
export const operations = [
  operation(70, 'waiting_user', { approval: approval(71) }),
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
  operation(78, 'unknown', {}),
];

// Local app (MCP) operations share the command card's styles.
const mcpArguments = {
  limits: { timeoutMs: 30_000 },
  source: {
    name: 'crm-tools',
    version: '1.2.0',
    entrypoint: 'server.js',
    files: [{ path: 'server.js', sha256: digest('7') }],
  },
  path: 'tools/crm',
  connectionId: id(90),
  connectionRevision: 1,
  deviceId: id(91),
  credential: null,
  imageDigest: digest('5'),
};
const mcpOperation = (n: number, status: string, extra: object) => ({
  snapshot: { status, binding: { attempt: { operationId: id(n) } } },
  deviceName: '王芳的 MacBook',
  approval: null,
  evidence: null,
  ...extra,
});
export const mcpOperations = [
  mcpOperation(92, 'waiting_user', {
    payload: {
      capability: 'local.mcp.call',
      arguments: {
        ...mcpArguments,
        tool: { name: 'find_customer' },
        toolArguments: { name: '上海星河贸易' },
      },
    },
    approval: approval(93),
  }),
  mcpOperation(95, 'succeeded', {
    payload: { capability: 'local.mcp.discover', arguments: mcpArguments },
    evidence: { tools: ['find_customer'], stopped: true },
  }),
  mcpOperation(96, 'unknown', {
    payload: { capability: 'local.mcp.discover', arguments: mcpArguments },
  }),
];
