import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CloudOperationView } from '@allrice/database';
import {
  CloudOperationCard,
  cloudOperationDisplayStatus,
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
  it('distinguishes a third-party send from chat/local execution and escapes parameters', () => {
    const html = render(view());
    expect(html).toContain('第三方 MCP 工具');
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
  it('marks unknown results without implying remote stop or offering replay', () => {
    const op = view();
    op.snapshot.status = 'unknown';
    const html = render(op);
    expect(html).toContain('不等于远端已经停止');
    expect(html).toContain('不会自动重放');
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
    expect(html).toContain('云端隔离计算');
    expect(html).toContain('禁止联网');
    expect(html).toContain('input.json');
    expect(html).toContain('256');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('第三方 MCP');
  });
});
