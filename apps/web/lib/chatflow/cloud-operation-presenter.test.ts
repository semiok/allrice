import { describe, expect, it } from 'vitest';
import type { CloudOperationView } from '@allrice/database';
import {
  approvalSummary,
  approveLabel,
  cloudOperationCompactLabel,
  cloudOperationStatusLabel,
  durationText,
  mcpApprovalDetails,
  mcpAuthorizationLabel,
  mcpFailureNotice,
  mcpRiskLabel,
  resourceLimitRows,
  resultNote,
  serviceHost,
  unconfirmedNote,
} from './cloud-operation-presenter';

type Proposal = CloudOperationView['proposal'];
const limits = {
  timeoutMs: 30_000,
  outputBytes: 32_768,
  artifactBytes: 1_000_000,
  memoryMiB: 512,
  cpuMillis: 500,
  pids: 64,
};
const mcp = (risk: string, args: unknown = { text: 'hi' }) =>
  ({
    kind: 'mcp',
    endpoint: 'https://api.example.com/mcp',
    tool: 'mcp__app__send_message',
    arguments: args,
    risk,
  }) as Extract<Proposal, { kind: 'mcp' }>;
const script = (extra: Partial<Proposal> = {}) =>
  ({
    kind: 'cloud',
    script: 'print(1)',
    inputs: [{ objectId: 'x', path: 'sales.csv', checksum: 'sha256:x' }],
    outputs: [],
    limits,
    ...extra,
  }) as Proposal;
// Engineering words an ordinary employee must not meet in the summary.
const engineering =
  /[{}]|待核实|回执|核实|Bridge|MCP|schema|digest|sha256|毫核|字节|[a-z]+_[a-z]+/;

describe('cloud operation wording for ordinary employees', () => {
  it('names every status in plain words, with one name for unconfirmed results', () => {
    for (const status of [
      'planned',
      'waiting_user',
      'waiting_device',
      'waiting_dependency',
      'ready',
      'dispatched',
      'running',
      'cancel_requested',
      'unknown',
      'succeeded',
      'failed',
      'canceled',
      'partial',
      'something_new',
    ])
      expect(cloudOperationStatusLabel(status)).not.toMatch(engineering);
    expect(cloudOperationStatusLabel('unknown')).toBe('结果待确认');
    expect(cloudOperationStatusLabel('something_new')).toBe('结果待确认');
    expect(cloudOperationStatusLabel('failed')).toBe('未完成');
    expect(cloudOperationStatusLabel('succeeded')).toBe('已完成');
    for (const kind of [
      'github_merge_permission',
      'authentication',
      'remote_error',
      'unavailable',
      'result_unknown',
    ] as const) {
      const { title, detail } = mcpFailureNotice(kind);
      expect(`${title}${detail}`).not.toMatch(/核实|403|MCP/);
    }
    expect(mcpFailureNotice('result_unknown').title).toBe('结果待确认');
    expect(mcpFailureNotice('authentication').detail).toContain('已链接应用');
    expect(mcpFailureNotice('github_merge_permission').title).toBe(
      'GitHub 权限不足',
    );
  });

  it('names a waiting step that can no longer be answered', () => {
    const op = (approval: Record<string, unknown> | null, extra = {}) =>
      ({
        snapshot: { status: 'waiting_user' },
        enabled: true,
        mcpAuthorization: { available: true, reason: 'available' },
        proposal: mcp('write'),
        approval: approval && {
          request: { expiresAt: '2026-10-26T10:00:00.000Z' },
          response: null,
          revokedAt: null,
          ...approval,
        },
        ...extra,
      }) as unknown as CloudOperationView;
    const before = Date.parse('2026-10-26T09:00:00.000Z');
    const after = Date.parse('2026-10-26T11:00:00.000Z');
    expect(cloudOperationCompactLabel(op({}), before)).toBe('等你确认');
    expect(cloudOperationCompactLabel(op({}), after)).toBe('已过期');
    expect(
      cloudOperationCompactLabel(
        op({ response: { decision: 'rejected' } }),
        before,
      ),
    ).toBe('你已拒绝');
    // An answer given before expiry stays the answer while the Worker catches up.
    expect(
      cloudOperationCompactLabel(
        op({ response: { decision: 'approved' } }),
        after,
      ),
    ).toBe('你已允许');
    expect(
      cloudOperationCompactLabel(op({ revokedAt: '2026-10-26T09:30:00Z' })),
    ).toBe('已撤回');
    expect(
      cloudOperationCompactLabel(
        op(
          {},
          {
            mcpAuthorization: {
              available: false,
              reason: 'connection_revoked',
            },
          },
        ),
        before,
      ),
    ).toBe('无法确认权限');
  });

  it('shows what a pending app call does, to whom and with which values', () => {
    const sales = mcpApprovalDetails(
      mcp('external_send', { channel: 'sales', text: '本周报价已更新' }),
    );
    const outside = mcpApprovalDetails(
      mcp('external_send', { channel: 'partner-ext', text: '报价单在附件' }),
    );
    expect(sales.action).toBe('send_message（对外发送内容）');
    expect(sales.target).toBe('api.example.com · 渠道 sales');
    expect(outside.target).toBe('api.example.com · 渠道 partner-ext');
    expect(sales.fields).toEqual([
      { key: 'channel', text: 'sales', full: 'sales' },
      { key: 'text', text: '本周报价已更新', full: '本周报价已更新' },
    ]);
    expect(JSON.stringify(outside.fields)).not.toBe(
      JSON.stringify(sales.fields),
    );
    const merge = mcpApprovalDetails({
      ...mcp('write', {
        owner: 'semiok',
        repo: 'allrice',
        pullNumber: 200,
        options: { squash: true, delete_branch: false },
        labels: ['ready', 'web'],
        reviewers: [{ login: 'a' }, { login: 'b' }],
        draft: null,
      }),
      tool: 'merge_pull_request',
    });
    expect(merge.action).toBe('merge_pull_request（写入数据）');
    expect(merge.target).toBe(
      'api.example.com · 仓库 semiok/allrice · 编号 200',
    );
    expect(
      Object.fromEntries(merge.fields.map((f) => [f.key, f.text])),
    ).toEqual({
      owner: 'semiok',
      repo: 'allrice',
      pullNumber: '200',
      options: 'squash 是，delete_branch 否',
      labels: 'ready、web',
      reviewers: '2 项',
      draft: '空',
    });
    for (const field of merge.fields) expect(field.text).not.toMatch(/[{}[\]]/);
    const long = mcpApprovalDetails(
      mcp('external_send', { text: '很长的消息'.repeat(40) }),
    ).fields[0]!;
    expect(long.text.length).toBe(80);
    expect(long.text.endsWith('…')).toBe(true);
    expect(long.full).toBe('很长的消息'.repeat(40));
  });

  it('says what an approval allows, without raw risk codes', () => {
    expect(approveLabel(mcp('external_send'))).toBe('允许对外发送内容');
    expect(approveLabel(mcp('write'))).toBe('允许写入数据');
    expect(approveLabel(mcp('brand_new_risk'))).toBe('允许完成这次操作');
    expect(mcpRiskLabel('brand_new_risk')).toBe('其他操作');
    expect(approveLabel(script())).toBe('允许运行脚本');
    const summary = approvalSummary(mcp('external_send'));
    expect(summary).toContain('会按下面的内容调用 api.example.com');
    expect(summary).not.toContain('send_message');
    for (const proposal of [mcp('read'), script(), script({ inputs: [] })])
      expect(approvalSummary(proposal)).not.toMatch(engineering);
    expect(approvalSummary(script())).toContain('只读取你提供的 1 个文件');
    expect(
      approvalSummary(
        script({
          network: {
            mode: 'controlled_https',
            origins: ['https://registry.npmjs.org'],
          },
        } as Partial<Proposal>),
      ),
    ).toContain('可以访问上面列出的网站');
    expect(serviceHost('not a url')).toBe('第三方应用');
  });

  it('never invites a resend when the outcome is unconfirmed', () => {
    for (const proposal of [
      mcp('write'),
      script(),
      script({
        network: { mode: 'controlled_https', origins: ['https://a.example'] },
      } as Partial<Proposal>),
    ])
      for (const status of ['unknown', 'cancel_requested']) {
        const note = unconfirmedNote(proposal, status);
        expect(note).toContain('不会自动重新执行');
        expect(note).not.toMatch(engineering);
      }
    expect(resultNote('failed')).toContain(
      '可以在对话里让 AI 员工换个方式再试',
    );
    expect(resultNote('succeeded')).toBeNull();
    for (const reason of [
      'connection_revoked',
      'connection_or_tool_changed',
      'employee_authorization_changed',
      undefined,
    ])
      expect(mcpAuthorizationLabel(reason)).not.toMatch(engineering);
  });

  it('reads durations and resource ceilings in ordinary units', () => {
    expect(durationText(30_000)).toBe('30 秒');
    expect(durationText(120_000)).toBe('2 分钟');
    expect(durationText(133_000)).toBe('2 分 13 秒');
    const rows = Object.fromEntries(resourceLimitRows(limits));
    expect(rows['算力']).toBe('0.5 核 CPU、512 MB 内存');
    expect(rows['进程数上限']).toBe('64 个');
    expect(rows['输出上限']).toMatch(/KB$/);
    expect(rows['成果上限']).toMatch(/KB$/);
    expect(JSON.stringify(rows)).not.toMatch(/毫核|字节|MiB/);
  });
});
