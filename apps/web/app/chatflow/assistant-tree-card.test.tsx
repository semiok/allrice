import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AssistantTreeView } from '@allrice/database';
import { AssistantTreeCard } from './assistant-tree-card';
import { presentAssistantTree } from '../../lib/chatflow/assistant-tree-presenter';

const root = '00000000-0000-4000-8000-000000000001';
const child = '00000000-0000-4000-8000-000000000002';
function fixture(): AssistantTreeView {
  return {
    rootRunId: root,
    configuration: {
      version: 1,
      mode: 'daily',
      allowAssistants: true,
      maxConcurrent: 2,
      maxDepth: 1,
      maxChildren: 4,
    },
    cancelRequested: false,
    instances: [
      {
        runId: root,
        parentRunId: null,
        rootRunId: root,
        nativeSessionId: root,
        label: 'Rice',
        depth: 0,
        status: 'running',
        allowedTools: [],
        artifactNamespace: `assistant/${root}/${root}/`,
        cancelRequestedAt: null,
        stoppedAt: null,
      },
      {
        runId: child,
        parentRunId: root,
        rootRunId: root,
        nativeSessionId: child,
        label: '资料核对',
        depth: 1,
        status: 'running',
        allowedTools: [],
        artifactNamespace: `assistant/${root}/${child}/`,
        cancelRequestedAt: null,
        stoppedAt: null,
      },
    ],
    messages: [],
    results: [],
    budgets: [],
    timing: null,
  };
}
function render(tree: AssistantTreeView, detailed = true) {
  return renderToStaticMarkup(
    <AssistantTreeCard
      tree={tree}
      detailed={detailed}
      busy={false}
      error=""
      onExpand={() => {}}
      onStopChild={() => {}}
      onCancelRoot={() => {}}
      onArtifact={() => {}}
    />,
  );
}

describe('P26 actual-state presentation (fixtures are not execution evidence)', () => {
  it('counts persisted children only, not root or proposed assistant count', () => {
    const tree = fixture();
    expect(presentAssistantTree(tree).label).toBe('Rice 已安排 1 个助手');
    tree.instances = tree.instances.slice(0, 1);
    expect(render(tree)).toContain('暂无助手');
    tree.configuration.allowAssistants = false;
    expect(render(tree)).toContain('本次不使用助手');
  });
  it('keeps pending stops visible outside default-collapsed details', () => {
    const tree = fixture();
    tree.cancelRequested = true;
    tree.instances[1]!.status = 'cancel_requested';
    tree.instances[1]!.cancelRequestedAt = '2026-09-14T04:00:00.000Z';
    const html = render(tree, false);
    expect(html.indexOf('已请求停止不代表进程已退出')).toBeLessThan(
      html.indexOf('<details'),
    );
    expect(html).toContain('1 项尚未确认停止');
    expect(html).not.toContain('执行端已确认停止');
    expect(presentAssistantTree(tree).hasLiveWork).toBe(true);
  });
  it('does not flatten partial/unknown/failed states into completed', () => {
    for (const status of ['partial', 'unknown', 'failed'] as const) {
      const tree = fixture();
      tree.instances[1]!.status = status;
      const html = render(tree);
      expect(html).toContain('1 个助手需要关注');
      expect(html.indexOf('资料核对：')).toBeLessThan(html.indexOf('<details'));
      expect(html).not.toContain('全部成功');
    }
  });
  it('distinguishes delivered results from actual parent adoption and preserves evidence version', () => {
    const tree = fixture();
    tree.results = [
      {
        runId: child,
        deliveryId: child,
        parentMessageId: child,
        parentAdoptedSeq: null,
        status: 'partial',
        summary: '两个来源可用，一个未完成。',
        incomplete: ['第三个来源不可用'],
        usageComplete: false,
        evidence: [{ id: child, digest: `sha256:${'a'.repeat(64)}` }],
      },
    ];
    let html = render(tree);
    expect(html).toContain('主 Rice 尚未确认采用');
    expect(html).toContain('第三个来源不可用');
    expect(html).toContain(`sha256:${'a'.repeat(64)}`);
    expect(html).toContain('不能视作零消耗');
    tree.results[0]!.parentAdoptedSeq = 42;
    html = render(tree);
    expect(html).toContain('主 Rice 已采用');
    expect(html).toContain('#42');
    expect(html).not.toContain('尚未确认采用');
  });
  it('escapes content and does not manufacture evidence for a text-only report', () => {
    const tree = fixture();
    tree.results = [
      {
        runId: child,
        deliveryId: child,
        parentMessageId: null,
        parentAdoptedSeq: null,
        status: 'completed',
        summary: '<script>alert(1)</script>',
        incomplete: [],
        usageComplete: true,
        evidence: [],
      },
    ];
    const html = render(tree);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('未附可追溯工件');
  });
  it('does not call inbox ACK durable/adopted, and shows real stop acknowledgement separately', () => {
    const tree = fixture();
    tree.messages = [
      {
        inputId: child,
        senderRunId: root,
        childRunId: child,
        text: '核对来源',
        status: 'accepted',
        nativeMessageId: 'n1',
        durableSeq: null,
        adoptedSeq: null,
      },
    ];
    expect(render(tree)).toContain('原生端已接收 · 尚未确认落盘');
    tree.instances[1]!.stoppedAt = '2026-09-14T04:01:00.000Z';
    tree.instances[1]!.status = 'canceled';
    expect(render(tree)).toContain('执行端已确认停止');
  });
});
