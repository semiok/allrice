import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CloudOperationView } from '@allrice/database';
import {
  CloudOperationCard,
  cloudOperationDisplayStatus,
  cloudOperationCompactStatus,
  cloudOperationsNeedPolling,
  laterSuccessfulMcpCall,
} from './cloud-operation-panel';

// Presentation-only fixtures. Contract and authority validation are exercised
// with persisted real-PG records by mcp-execution.integration.test.ts.
function view(): CloudOperationView {
  return {
    snapshot: {
      status: 'waiting_user',
      binding: { attempt: { operationId: 'synthetic-display-id' } },
    },
    enabled: true,
    mcpAuthorization: { available: true, reason: 'available' },
    proposal: {
      kind: 'mcp',
      endpoint: 'https://owned.example.test/mcp',
      tool: 'records.append',
      arguments: { value: '<script>alert(1)</script>' },
      risk: 'write',
    },
    approval: {
      request: { expiresAt: new Date(Date.now() + 60000).toISOString() },
      response: null,
      consumedAt: null,
      revokedAt: null,
    },
    result: null,
  } as unknown as CloudOperationView;
}
const render = (op: CloudOperationView, busy = false) =>
  renderToStaticMarkup(
    <CloudOperationCard op={op} busy={busy} onAct={() => {}} />,
  );
describe('Cloud/MCP approval presentation', () => {
  it('shows saved-project commands and versions without presenting them as scripts or third-party calls', () => {
    const op = view();
    op.snapshot.status = 'succeeded';
    op.approval = null;
    op.mcpAuthorization = null;
    op.proposal = {
      kind: 'project',
      project: {
        projectId: 'project-id',
        snapshot: {
          kind: 'artifact',
          id: 'snapshot-id',
          version: '1',
          checksum: 'sha256:' + 'a'.repeat(64),
        },
      },
      sourceDigest: 'sha256:' + 'b'.repeat(64),
      executable: '/usr/local/bin/node',
      args: ['verify.cjs', '<script>'],
      path: '.',
      files: [],
      outputs: [
        { path: 'dist/index.html', fileName: 'result.html', format: 'html' },
      ],
      preparation: {
        version: 1,
        projectId: 'project-id',
        sourceDigest: 'sha256:' + 'b'.repeat(64),
        manager: 'pnpm',
        managerVersion: '10.33.3',
        lockPath: 'pnpm-lock.yaml',
        lockChecksum: 'sha256:' + 'a'.repeat(64),
        offline: true,
        scripts: 'disabled',
        packages: [],
      },
      limits: {
        timeoutMs: 60000,
        outputBytes: 16384,
        memoryMiB: 256,
        cpuMillis: 1000,
        pids: 64,
      },
    } as CloudOperationView['proposal'];
    const html = render(op);
    expect(html).toContain('云端项目');
    expect(html).toContain('云端项目命令');
    expect(html).toContain('项目版本');
    expect(html).toContain('verify.cjs');
    expect(html).toContain('result.html');
    expect(html).not.toContain('云端待执行脚本');
    expect(html).not.toContain('第三方服务');
    expect(html).not.toContain('<script>');
  });
  it('keeps compact statuses distinct from unconfirmed remote outcomes', () => {
    const op = view();
    for (const [status, label] of [
      ['running', '执行中'],
      ['succeeded', '成功'],
      ['failed', '失败'],
      ['unknown', '结果待确认'],
      ['cancel_requested', '停止待确认'],
      ['dispatched', '待确认'],
    ] as const) {
      op.snapshot.status = status;
      expect(cloudOperationCompactStatus(op)).toBe(label);
    }
  });
  it.each(['read_only', 'write'])(
    'links a later successful %s call without clearing failures or unknown effects',
    (risk) => {
      const failed = view();
      failed.proposal = {
        ...failed.proposal,
        risk,
      } as CloudOperationView['proposal'];
      failed.snapshot.status = 'failed';
      failed.snapshot.binding.execution = {
        targetId: 'same-connection',
      } as CloudOperationView['snapshot']['binding']['execution'];
      failed.snapshot.binding.task = {
        runId: 'run-a',
      } as CloudOperationView['snapshot']['binding']['task'];
      failed.snapshot.result = {
        status: 'failed',
        effects: 'none',
        evidence: { recordedAt: '2026-09-28T06:00:00Z' },
      } as NonNullable<CloudOperationView['snapshot']['result']>;
      const succeeded = structuredClone(failed);
      succeeded.snapshot.status = 'succeeded';
      succeeded.snapshot.binding.attempt.operationId = 'later-success';
      succeeded.snapshot.result = {
        ...failed.snapshot.result,
        status: 'succeeded',
        evidence: {
          ...failed.snapshot.result.evidence,
          recordedAt: '2026-09-28T06:01:00Z',
        },
      };
      expect(laterSuccessfulMcpCall(failed, [failed, succeeded])).toBe(
        'later-success',
      );
      const html = renderToStaticMarkup(
        <CloudOperationCard
          op={failed}
          busy={false}
          laterSuccessId="later-success"
          onAct={() => {}}
        />,
      );
      expect(html).toContain('后续调用已成功');
      expect(html).toContain('href="#operation-later-success"');
      expect(failed.snapshot.status).toBe('failed');
      const other = structuredClone(succeeded);
      other.snapshot.binding.task.runId = 'run-b';
      expect(laterSuccessfulMcpCall(failed, [other])).toBeUndefined();
      (other.proposal as { tool: string }).tool = 'different.tool';
      other.snapshot.binding.task.runId = 'run-a';
      expect(laterSuccessfulMcpCall(failed, [other])).toBeUndefined();
      failed.snapshot.status = 'unknown';
      expect(laterSuccessfulMcpCall(failed, [succeeded])).toBeUndefined();
    },
  );
  it('distinguishes a third-party send from chat/local execution and escapes parameters', () => {
    const html = render(view());
    expect(html).toContain('应用工具');
    expect(html).toContain('发送给此第三方服务');
    expect(html).toContain('批准这一次执行');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
  it.each(['rejected', 'expired', 'revoked'] as const)(
    'shows %s and removes approval actions',
    (state) => {
      const op = view();
      if (state === 'rejected')
        op.approval!.response = { decision: 'rejected' } as NonNullable<
          CloudOperationView['approval']
        >['response'];
      if (state === 'expired')
        op.approval!.request.expiresAt = '2000-01-01T00:00:00.000Z';
      if (state === 'revoked')
        op.approval!.revokedAt = new Date().toISOString();
      expect(render(op)).not.toContain('批准这一次执行');
      expect(cloudOperationDisplayStatus(op)).toContain(
        state === 'rejected' ? '拒绝' : state === 'expired' ? '过期' : '撤销',
      );
    },
  );
  it('keeps historical status and cancel control after feature shutdown', () => {
    const op = view();
    op.enabled = false;
    const html = render(op);
    expect(html).toContain('新执行已停用');
    expect(html).toContain('请求停止本轮全部操作');
    expect(html).not.toContain('批准这一次执行');
  });
  it.each([
    ['connection_revoked', '连接授权已撤销'],
    ['connection_or_tool_changed', '连接或工具授权已变化'],
    ['employee_authorization_changed', '员工授权已失效'],
    ['unavailable', '当前授权暂时无法核实'],
  ] as const)(
    'removes approval for current %s without rewriting its historical request',
    (reason, label) => {
      const op = view();
      const approval = structuredClone(op.approval);
      op.mcpAuthorization = { available: false, reason };
      const html = render(op);
      expect(cloudOperationDisplayStatus(op)).toBe(label);
      expect(html).toContain(label);
      expect(html).not.toContain('批准这一次执行');
      expect(html).toContain('请求停止本轮全部操作');
      expect(html).toContain('已派发的操作不等于已经停止');
      expect(op.approval).toEqual(approval);
      expect(op.approval!.revokedAt).toBeNull();
    },
  );
  it('fails closed for missing MCP authority, but preserves a terminal result', () => {
    const op = view();
    op.mcpAuthorization = null;
    expect(render(op)).not.toContain('批准这一次执行');
    op.snapshot.status = 'succeeded';
    op.result = {
      output: 'saved:synthetic;call-count:1',
      code: null,
      trusted: false,
    };
    const html = render(op);
    expect(cloudOperationDisplayStatus(op)).toBe('执行成功');
    expect(html).toContain('saved:synthetic;call-count:1');
    expect(html).not.toContain('请求停止本轮全部操作');
    expect(op.result.trusted).toBe(false);
  });
  it('marks unknown results without implying remote stop or offering replay', () => {
    const op = view();
    op.snapshot.status = 'unknown';
    const html = render(op);
    expect(html).toContain('未收到应用执行结果');
    expect(html).toContain('不会自动重试');
    expect(html).not.toContain('批准这一次执行');
  });
  it('renders exact cloud script, inputs and limits independently of MCP/local wording', () => {
    const op = view();
    op.proposal = {
      kind: 'cloud',
      script: "console.log('<script>')",
      inputs: [
        {
          objectId: '11111111-1111-4111-8111-111111111111',
          path: 'input.json',
          checksum: `sha256:${'a'.repeat(64)}`,
        },
      ],
      outputs: [
        { path: 'result.json', fileName: 'result.json', format: 'json' },
      ],
      limits: {
        timeoutMs: 30000,
        outputBytes: 32768,
        artifactBytes: 1000000,
        memoryMiB: 256,
        cpuMillis: 500,
        pids: 64,
      },
    };
    const html = render(op, true);
    expect(html).toContain('云端计算');
    expect(html).toContain('不联网');
    expect(html).toContain('input.json');
    expect(html).toContain('计划输出：');
    expect(html).toMatch(/<button[^>]*aria-expanded="true"[^>]*>/);
    expect(html).toContain('收起详情');
    op.snapshot.status = 'succeeded';
    expect(render(op)).toMatch(/<button[^>]*aria-expanded="false"[^>]*>/);
    expect(render(op)).toContain('查看详情');
    expect(html).toContain('256');
    expect(html).toContain('disabled=""');
    expect(html).toContain('批准这一次执行');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('第三方 MCP');
  });
});

describe('reported MCP failures remain visible without replay controls', () => {
  it('shows the GitHub denial and next step while retaining unknown effects', () => {
    const op = view();
    op.snapshot.status = 'unknown';
    op.proposal = {
      kind: 'mcp',
      endpoint: 'https://api.githubcopilot.com/mcp/',
      tool: 'mcp__app__merge_pull_request',
      arguments: {},
      risk: 'write',
    };
    op.result = {
      code: 'MCP_REMOTE_ERROR_EFFECTS_UNKNOWN',
      trusted: false,
      output: JSON.stringify({
        isError: true,
        error: {
          message:
            'failed to merge pull request: PUT https://api.github.com/repos/semiok/allrice/pulls/200/merge: 403 Resource not accessible by personal access token []',
        },
      }),
    };
    const html = renderToStaticMarkup(
      <CloudOperationCard
        op={op}
        busy={false}
        runActive={false}
        onAct={() => {
          throw Error('no action expected');
        }}
      />,
    );
    expect(cloudOperationDisplayStatus(op)).toBe('GitHub 权限不足');
    expect(html).toContain('本轮已结束');
    expect(html).toContain('Contents');
    expect(html).not.toContain('请求停止本轮全部操作');
    expect(html).not.toContain('远端结果待核实');
    expect(op.snapshot.status).toBe('unknown');
    expect(cloudOperationsNeedPolling(false, [op])).toBe(false);
    expect(cloudOperationsNeedPolling(true, [op])).toBe(true);
  });
  it('continues observing active or stopping operations, but not a settled unknown', () => {
    const op = view();
    for (const status of [
      'running',
      'cancel_requested',
      'dispatched',
    ] as const) {
      op.snapshot.status = status;
      expect(cloudOperationsNeedPolling(false, [op])).toBe(true);
    }
    op.snapshot.status = 'unknown';
    expect(cloudOperationsNeedPolling(false, [op])).toBe(false);
  });
});
