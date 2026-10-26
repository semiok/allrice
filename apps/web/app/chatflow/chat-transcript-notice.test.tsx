import { createRef, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatTranscript } from './chat-transcript';
import type { Message, RunView } from './chatflow-types';

const message: Message = {
  id: 'message-1',
  role: 'assistant',
  content: { text: '本周销售已整理好' },
  status: 'completed',
  runId: 'run-1',
  createdAt: '2026-10-26T09:00:00Z',
};
const render = (overrides: Partial<ComponentProps<typeof ChatTranscript>>) =>
  renderToStaticMarkup(
    <ChatTranscript
      atBottom
      messages={[message]}
      runTraces={{}}
      runViews={{}}
      tenantHeaders={{}}
      transcriptColumn={createRef<HTMLDivElement>()}
      workspaceId="synthetic-workspace"
      onLoadRunTrace={() => {}}
      onRecoverRun={() => {}}
      onScrollToBottom={() => {}}
      {...overrides}
    />,
  );

describe('conversation refresh notice', () => {
  it('says the conversation may be behind and offers a refresh', () => {
    const html = render({
      historyStale: true,
      onRefreshHistory: async () => {},
    });
    expect(html).toContain('对话内容可能不是最新的');
    expect(html).toMatch(/<button[^>]*>刷新<\/button>/);
    expect(html).toContain('本周销售已整理好');
  });

  it('stays quiet without a failed refresh or a way to refresh', () => {
    expect(render({})).not.toContain('对话内容可能不是最新的');
    expect(render({ historyStale: true })).not.toContain(
      '对话内容可能不是最新的',
    );
  });

  it('lets a broken live connection speak first', () => {
    const view: RunView = {
      runId: 'run-1',
      status: 'connecting',
      cursor: null,
      reconnects: 7,
      connectionError: '实时连接暂时中断',
      events: [],
    };
    const html = render({
      historyStale: true,
      onRefreshHistory: async () => {},
      recoverableRunView: view,
    });
    expect(html).toContain('实时连接暂时中断');
    expect(html).not.toContain('对话内容可能不是最新的');
  });
});
