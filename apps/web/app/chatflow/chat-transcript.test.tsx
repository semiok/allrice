import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatTranscript } from './chat-transcript';
import type { Message } from './chatflow-types';

const panels = vi.hoisted(() => ({ local: vi.fn(), cloud: vi.fn() }));
vi.mock('./local-command-panel', () => ({ LocalCommandPanel: panels.local }));
vi.mock('./cloud-operation-panel', () => ({
  CloudOperationPanel: panels.cloud,
}));

const messages: Message[] = Array.from({ length: 20 }, (_, index) => ({
  id: `message-${index}`,
  role: 'assistant',
  content: { text: 'An existing answer' },
  status: 'completed',
  runId: `run-${index}`,
  createdAt: '2026-09-08T11:00:00Z',
}));
function render(enabled?: boolean, shownMessages = messages) {
  panels.local.mockReturnValue(null);
  panels.cloud.mockReturnValue(null);
  return renderToStaticMarkup(
    <ChatTranscript
      atBottom
      localCommandsEnabled={enabled}
      messages={shownMessages}
      runTraces={{}}
      runViews={{}}
      tenantHeaders={{}}
      transcriptColumn={createRef<HTMLDivElement>()}
      workspaceId="synthetic-workspace"
      onLoadRunTrace={() => {}}
      onRecoverRun={() => {}}
      onScrollToBottom={() => {}}
    />,
  );
}
describe('historical transcript capability gating', () => {
  afterEach(() => vi.clearAllMocks());

  it.each(['failed', 'completed'] as const)(
    'keeps the answer and only explains a recovered historical failure (%s)',
    (status) => {
      const html = render(false, [
        {
          ...messages[0]!,
          status,
          errorCode:
            status === 'failed' ? 'MODEL_OUTPUT_BUDGET_EXCEEDED' : null,
          content: {
            text: 'Preserved complete answer',
            budgetWarning: 'MODEL_TOTAL_TOKEN_BUDGET_EXCEEDED',
          },
        },
      ]);
      expect(html).toContain('Preserved complete answer');
      if (status === 'failed') {
        expect(html).toContain('答案已保留');
      } else {
        expect(html).not.toContain('答案已保留');
        expect(html).not.toContain('超过平台内部预期');
        expect(html).not.toContain('周额度');
      }
      expect(html).not.toContain('这次没有完成');
    },
  );

  it('does not warn for either kind of completed internal budget overrun', () => {
    for (const budgetWarning of [
      'MODEL_TOTAL_TOKEN_BUDGET_EXCEEDED',
      'MODEL_OUTPUT_BUDGET_EXCEEDED',
    ] as const) {
      const html = render(false, [
        {
          ...messages[0]!,
          content: { text: 'Normal completed answer', budgetWarning },
        },
      ]);
      expect(html).toContain('Normal completed answer');
      expect(html).not.toContain('超过平台内部预期');
      expect(html).not.toContain('这次没有完成');
    }
  });

  it.each(['MODEL_TOTAL_TOKEN_BUDGET_EXCEEDED', 'TIMEOUT', 'RATE_LIMITED'])(
    'keeps real failures visible: %s',
    (errorCode) => {
      const html = render(false, [
        {
          ...messages[0]!,
          status: 'failed',
          errorCode,
        },
      ]);
      expect(html).toContain('这次没有完成');
    },
  );

  it.each([undefined, false])(
    'never mounts a local request panel while disabled (%s)',
    (enabled) => {
      expect(render(enabled)).toContain('An existing answer');
      expect(panels.local).not.toHaveBeenCalled();
      // Cloud history stays readable when new execution is OFF.
      expect(panels.cloud).toHaveBeenCalledTimes(20);
    },
  );

  it('preserves command approval/history panels when all server flags allow the route', () => {
    render(true);
    expect(panels.local).toHaveBeenCalledTimes(20);
    expect(panels.local.mock.calls[0]![0]).toMatchObject({
      runId: 'run-0',
      runActive: false,
    });
  });
});
