// Isolated hosts only. Memory reads and writes use the real HTTP routes.
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ChatFlowEventEnvelope } from '@allrice/contracts';
import { ChatTranscript } from '../app/chatflow/chat-transcript';
import { WorkbenchExperiencePanel } from '../app/chatflow/workbench-experience-panel';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/dsh-upstream/scrollbar.css';
import '@allrice/ui/tokens.css';
import '../app/styles/base.css';
import '@allrice/ui/styles.css';

type Fixture = {
  organizationId: string;
  workspaceId: string;
  otherWorkspaceId: string;
  runId: string;
  userMessageId: string;
  assistantMessageId: string;
};
function App({ fixture }: { fixture: Fixture }) {
  const [workspaceId, setWorkspace] = useState(fixture.workspaceId);
  const column = useRef<HTMLDivElement>(null);
  const query = new URLSearchParams(location.search);
  const management = query.get('host') === 'management';
  const headers = {
    'x-allrice-organization-id': fixture.organizationId,
    'x-allrice-workspace-id': workspaceId,
  };
  const events: ChatFlowEventEnvelope[] = query.has('no-event')
    ? []
    : [
        {
          eventId: fixture.assistantMessageId,
          schemaVersion: 3,
          organizationId: fixture.organizationId,
          workspaceId,
          runId: fixture.runId,
          sequence: 1,
          generation: 1,
          cursor: `${fixture.runId}:1`,
          conversationId: fixture.runId,
          harness: 'dsh',
          sourceEvent: null,
          occurredAt: new Date().toISOString(),
          type: 'tool.completed',
          payload: {
            name: 'workspace_memory_remember',
            toolCallId: 'synthetic-completed',
            // A forged model claim is deliberately not an authority source.
            memoryId: query.get('forged-memory'),
          },
        },
      ];
  return (
    <main style={{ width: '100%', maxWidth: 900, margin: '0 auto' }}>
      <button
        type="button"
        onClick={() => setWorkspace(fixture.otherWorkspaceId)}
      >
        切换测试工作区
      </button>
      {management ? (
        <WorkbenchExperiencePanel
          scopeId={workspaceId}
          workspaceId={workspaceId}
          instanceId="not-a-memory-employee-id"
          employees={[]}
          headers={headers}
          active
          automatic={false}
          onCorrect={() => {
            throw Error('Unexpected correction/model path');
          }}
        />
      ) : (
        <ChatTranscript
          memoryScope={workspaceId}
          workspaceId={workspaceId}
          employeeName="AllRice 助手"
          messages={[
            {
              id: fixture.userMessageId,
              role: 'user',
              content: { text: '帮我记一下偏好' },
              status: 'completed',
              runId: fixture.runId,
              createdAt: new Date().toISOString(),
            },
            {
              id: fixture.assistantMessageId,
              role: 'assistant',
              content: { text: '' },
              status: 'completed',
              runId: fixture.runId,
              createdAt: new Date().toISOString(),
            },
          ]}
          runViews={{}}
          runTraces={{ [fixture.runId]: { status: 'loaded', events } }}
          tenantHeaders={headers}
          transcriptColumn={column}
          atBottom
          transcriptView="compact"
          collapseTiming="completion"
          onLoadRunTrace={() => {}}
          onRecoverRun={() => {
            throw Error('Unexpected model recovery');
          }}
          onScrollToBottom={() => {}}
        />
      )}
    </main>
  );
}
void fetch('/fixture')
  .then((response) => response.json())
  .then((fixture) => {
    createRoot(document.getElementById('root')!).render(
      <App fixture={fixture} />,
    );
  });
