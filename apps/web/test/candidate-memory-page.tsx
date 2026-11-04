// Isolated hosts only. Memory reads and writes use the real HTTP routes.
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createRoot } from 'react-dom/client';
import type { ChatFlowEventEnvelope } from '@allrice/contracts';
import { ChatTranscript } from '../app/chatflow/chat-transcript';
import { WorkbenchExperiencePanel } from '../app/chatflow/workbench-experience-panel';
import { createSessionRunStream } from '../app/chatflow/session-run-stream';
import type { History } from '../app/chatflow/chatflow-types';
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
  sessionId: string;
  assignmentId: string;
  versionId: string;
};
function completedHistory(fixture: Fixture): History {
  const createdAt = '2026-11-02T00:00:00.000Z';
  return {
    session: {
      id: fixture.sessionId,
      title: '恢复测试',
      employeeAssignmentId: fixture.assignmentId,
      employeeVersionId: fixture.versionId,
      visibility: 'private',
      updatedAt: createdAt,
      archivedAt: null,
    },
    messages: [
      {
        id: fixture.userMessageId,
        role: 'user',
        content: { text: '帮我记一下偏好' },
        status: 'completed',
        runId: fixture.runId,
        createdAt,
      },
      {
        id: fixture.assistantMessageId,
        role: 'assistant',
        content: { text: '' },
        status: 'completed',
        runId: fixture.runId,
        createdAt,
      },
    ],
    contextStatus: {
      percentage: 0,
      pressureTokens: 0,
      thresholdTokens: 40000,
      compactionDue: false,
    },
    nativeContextStatus: null,
  };
}
function App({ fixture }: { fixture: Fixture }) {
  const [workspaceId, setWorkspace] = useState(fixture.workspaceId);
  const column = useRef<HTMLDivElement>(null);
  const query = new URLSearchParams(location.search);
  const management = query.get('host') === 'management';
  const recovery = query.get('host') === 'recovery';
  const headers = {
    'x-allrice-organization-id': fixture.organizationId,
    'x-allrice-workspace-id': workspaceId,
  };
  const history = useMemo(() => completedHistory(fixture), [fixture]);
  const stream = useMemo(
    () =>
      createSessionRunStream({
        sessionId: fixture.sessionId,
        workspaceId,
        tenantHeaders: {
          'x-allrice-organization-id': fixture.organizationId,
          'x-allrice-workspace-id': workspaceId,
        },
        loadHistory: async () => {},
        loadWorkspace: async () => {},
        setError: () => {},
      }),
    [fixture.sessionId, fixture.organizationId, workspaceId],
  );
  const restored = useSyncExternalStore(
    stream.subscribe,
    stream.getSnapshot,
    stream.getSnapshot,
  );
  useEffect(() => {
    if (!recovery) return;
    stream.activate();
    stream.restoreHistory({
      ...history,
      messages: history.messages.map((message) =>
        message.role === 'assistant'
          ? { ...message, status: 'pending' }
          : message,
      ),
    });
    return () => stream.deactivate();
  }, [stream, history, recovery]);
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
      {recovery && (
        <>
          <button type="button" onClick={() => stream.restoreHistory(history)}>
            恢复已完成历史
          </button>
          <output
            aria-label="恢复传输状态"
            data-live-events={
              restored.runViews[fixture.runId]?.events.length ?? 0
            }
            data-trace-state={
              restored.runTraces[fixture.runId]?.status ?? 'none'
            }
          >
            恢复传输状态
          </output>
        </>
      )}
      {management ? (
        <WorkbenchExperiencePanel
          scopeId={workspaceId}
          workspaceId={workspaceId}
          instanceId={fixture.assignmentId}
          employees={[{id:fixture.assignmentId,name:'测试助手'}]}
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
          messages={history.messages}
          runViews={recovery ? restored.runViews : {}}
          runTraces={
            recovery
              ? restored.runTraces
              : { [fixture.runId]: { status: 'loaded', events } }
          }
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
