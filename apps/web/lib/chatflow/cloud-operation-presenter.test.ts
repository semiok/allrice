import { describe, expect, it } from 'vitest';
import type { CloudOperationView } from '@allrice/database';
import {
  approvalSummary,
  approveLabel,
  approvalState,
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

  it('names a waiting step by what admission would check now', () => {
    const op = (approval: Record<string, unknown> | null, extra = {}) =>
      ({
        snapshot: { status: 'waiting_user' },
        enabled: true,
        mcpAuthorization: { available: true, reason: 'available' },
        proposal: mcp('write'),
        approval: approval && {
          request: { expiresAt: '2026-10-26T10:00:00.000Z' },
          response: null,
          consumedAt: null,
          revokedAt: null,
          ...approval,
        },
        ...extra,
      }) as unknown as CloudOperationView;
    const before = Date.parse('2026-10-26T09:00:00.000Z');
    const after = Date.parse('2026-10-26T11:00:00.000Z');
    const allowed = { response: { decision: 'approved' } };
    const lost = {
      mcpAuthorization: { available: false, reason: 'connection_revoked' },
    };
    const cases: [CloudOperationView, number, string, string][] = [
      [op({}), before, '等你确认', '等你确认'],
      [op({}), after, '已过期', '已过期，没有执行'],
      [op(allowed), before, '你已允许', '你已允许，正在准备'],
      // An unconsumed approval still expires: the server re-checks it.
      [op(allowed), after, '已过期', '你已允许，但开始前授权已过期，没有执行'],
      [
        op({ ...allowed, consumedAt: '2026-10-26T09:10:00Z' }),
        after,
        '你已允许',
        '你已允许，正在准备',
      ],
      [
        op(allowed, lost),
        before,
        '无法确认权限',
        '你已允许，但应用连接已断开，不能执行这一步',
      ],
      [op({}, lost), before, '无法确认权限', '应用连接已断开，不能执行这一步'],
      [
        op(allowed, { enabled: false }),
        before,
        '已暂停',
        '你已允许，但这类操作已暂停使用，暂时不能执行',
      ],
      [
        op({ response: { decision: 'rejected' } }),
        after,
        '你已拒绝',
        '你已拒绝，没有执行',
      ],
      [
        op({ ...allowed, revokedAt: '2026-10-26T09:30:00Z' }),
        before,
        '已撤回',
        '你已允许，但授权已撤回，没有执行',
      ],
    ];
    for (const [item, now, short, full] of cases) {
      // Short word and full sentence come from one decision.
      expect(approvalState(item, now)).toEqual({ short, full });
      expect(cloudOperationCompactLabel(item, now)).toBe(short);
    }
    const running = op(allowed);
    running.snapshot.status = 'running';
    expect(approvalState(running)).toBeNull();
    expect(cloudOperationCompactLabel(running)).toBe('进行中');
  });

  it('shows every parameter value with its path, so different calls differ', () => {
    const external = (email: string) =>
      mcpApprovalDetails(
        mcp('external_send', {
          subject: '报价',
          recipients: [{ email, name: { first: '张' } }],
        }),
      );
    const own = external('sales@example.com');
    const outside = external('buyer@partner.example');
    // Only a deeply nested value differs, and the details differ with it.
    expect(own.fields).toEqual([
      { path: 'subject', text: '报价', full: '报价' },
      {
        path: 'recipients 第 1 项 · email',
        text: 'sales@example.com',
        full: 'sales@example.com',
      },
      { path: 'recipients 第 1 项 · name · first', text: '张', full: '张' },
    ]);
    expect(outside.fields[1]!.full).toBe('buyer@partner.example');
    expect(own.targets).toEqual([
      { label: '收件人', value: 'sales@example.com' },
    ]);
    expect(outside.targets[0]).toEqual({
      label: '收件人',
      value: 'buyer@partner.example',
    });
    const merge = mcpApprovalDetails({
      ...mcp('write', {
        owner: 'semiok',
        repo: 'allrice',
        pullNumber: 200,
        options: { squash: true, delete_branch: false },
        labels: ['ready', 'web'],
        draft: null,
        title: '',
        reviewers: [],
      }),
      tool: 'merge_pull_request',
    });
    expect(merge.action).toBe('merge_pull_request（写入数据）');
    expect(merge.host).toBe('api.example.com');
    expect(merge.targets).toEqual([
      { label: '仓库', value: 'semiok/allrice' },
      { label: '编号', value: '200' },
    ]);
    expect(
      Object.fromEntries(merge.fields.map((f) => [f.path, f.full])),
    ).toEqual({
      owner: 'semiok',
      repo: 'allrice',
      pullNumber: '200',
      'options · squash': '是',
      'options · delete_branch': '否',
      'labels 第 1 项': 'ready',
      'labels 第 2 项': 'web',
      draft: '（空）',
      title: '（空文字）',
      reviewers: '（空列表）',
    });
  });

  it('keeps a value whole: its separators and line breaks stay inside it', () => {
    const tricky = mcpApprovalDetails(
      mcp('external_send', {
        text: '第一行\nchannel：伪装的字段',
      }),
    );
    expect(tricky.fields).toEqual([
      {
        path: 'text',
        text: '第一行\nchannel：伪装的字段',
        full: '第一行\nchannel：伪装的字段',
      },
    ]);
    const lines = Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 行`).join(
      '\n',
    );
    const many = mcpApprovalDetails(mcp('external_send', { text: lines }))
      .fields[0]!;
    expect(many.text).toBe('第 1 行\n第 2 行\n第 3 行\n第 4 行…');
    expect(many.full).toBe(lines);
    const long = mcpApprovalDetails(
      mcp('external_send', { text: '很长的消息'.repeat(40) }),
    ).fields[0]!;
    expect(long.text.length).toBe(80);
    expect(long.text.endsWith('…')).toBe(true);
    // 「展开全文」 shows the real value, never a summary.
    expect(long.full).toBe('很长的消息'.repeat(40));
    const huge = mcpApprovalDetails(
      mcp('write', {
        rows: Array.from({ length: 60 }, (_, i) => ({ id: i })),
      }),
    );
    expect(huge.fields).toHaveLength(50);
    expect(huge.moreFields).toBe(10);
  });

  it('keeps the whole tool name after the DSH app prefix', () => {
    const action = (tool: string) =>
      mcpApprovalDetails({ ...mcp('destructive', {}), tool }).action;
    expect(action('mcp__app__archive__delete')).toBe(
      'archive__delete（删除或改动数据）',
    );
    expect(action('mcp__app__live__delete')).toBe(
      'live__delete（删除或改动数据）',
    );
    expect(action('records.append')).toBe('records.append（删除或改动数据）');
    expect(action('mcp__other__delete')).toBe(
      'mcp__other__delete（删除或改动数据）',
    );
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
