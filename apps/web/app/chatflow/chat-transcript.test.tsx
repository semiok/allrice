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
function render(enabled?: boolean) {
  panels.local.mockReturnValue(null);
  panels.cloud.mockReturnValue(null);
  return renderToStaticMarkup(
    <ChatTranscript
      atBottom
      localCommandsEnabled={enabled}
      messages={messages}
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
