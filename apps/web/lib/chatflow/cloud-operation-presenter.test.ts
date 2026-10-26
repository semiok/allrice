import { describe, expect, it } from 'vitest';
import type { CloudOperationView } from '@allrice/database';
import {
  approvalSummary,
  approveLabel,
  cloudOperationStatusLabel,
  durationText,
  mcpAuthorizationLabel,
  mcpFailureTitle,
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
const mcp = (risk: string): Proposal => ({
  kind: 'mcp',
  endpoint: 'https://api.example.com/mcp',
  tool: 'mcp__app__send_message',
  arguments: { text: 'hi' },
  risk,
});
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
    expect(mcpFailureTitle('result_unknown')).toBe('结果待确认');
    expect(mcpFailureTitle('github_merge_permission')).toBe('GitHub 权限不足');
  });

  it('says what an approval allows, without tool names or raw risk codes', () => {
    expect(approveLabel(mcp('external_send'))).toBe('允许对外发送内容');
    expect(approveLabel(mcp('write'))).toBe('允许写入数据');
    expect(approveLabel(mcp('brand_new_risk'))).toBe('允许完成这次操作');
    expect(mcpRiskLabel('brand_new_risk')).toBe('其他操作');
    expect(approveLabel(script())).toBe('允许运行脚本');
    const summary = approvalSummary(mcp('external_send'));
    expect(summary).toContain('发送给 api.example.com');
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
