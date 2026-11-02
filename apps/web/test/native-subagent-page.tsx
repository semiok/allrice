import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { EmployeeSidebar } from '../app/chatflow/employee-sidebar';
import { NativeSubagentDirectory } from '../app/chatflow/native-subagent-directory';
import {
  WorkbenchEntries,
  WorkbenchStart,
  moduleLabels,
  type WorkbenchModule,
} from '../app/chatflow/workbench-modules';
import { applyTheme } from '../lib/theme/theme';
import { nativeSubagentControlRoot } from '../app/chatflow/native-subagent-controls';
import { presentationPolicyFor } from '../app/chatflow/dsh-upstream/presentation/presentation-policy';
import {
  nativeSubagentReadyKey,
  useNativeSubagents,
} from '../app/chatflow/use-native-subagents';
import { createSessionRunStream } from '../app/chatflow/session-run-stream';
import conversationUi from '../app/chatflow/dsh-upstream/ConversationRoot.module.css';
import shellUi from '../app/chatflow/dsh-saas.module.css';
import type { Session, Workspace } from '../app/chatflow/chatflow-types';

export const sessions: Session[] = ['parent-a', 'parent-b', 'parent-c'].map(
  (id) => ({
    id,
    title: `${id} 父级任务`,
    ownerId: 'viewer',
    employeeAssignmentId: 'employee',
    employeeVersionId: 'version',
    visibility: 'private',
    updatedAt: '2026-10-30T00:00:00Z',
    archivedAt: null,
    running: false,
  }),
);
const workspace: Workspace = {
  viewerId: 'viewer',
  organizationId: 'org',
  workspaceId: 'workspace',
  employees: [],
  employeeProfiles: [],
  sessions,
  sessionModels: [],
  canAdminister: false,
};
const headers = {
  'x-allrice-organization-id': 'org',
  'x-allrice-workspace-id': 'workspace',
};
function Page() {
  const [activeId, setActiveId] = useState('parent-a');
  const query = new URLSearchParams(location.search);
  const icons = query.has('icons');
  const [selected, setSelected] = useState<WorkbenchModule | null>(null);
  const controls = query.has('controls');
  const rootEvents = controls || query.has('root-events');
  const [controlRunId, setControlRunId] = useState(
    '44444444-4444-4444-8444-444444444444',
  );
  const rootRunId = controls ? controlRunId : 'root-run';
  const [ownerId, setOwnerId] = useState('viewer');
  const stream = useMemo(
    () =>
      createSessionRunStream({
        sessionId: activeId,
        workspaceId: 'workspace',
        tenantHeaders: headers,
        loadHistory: async () => {},
        loadWorkspace: async () => {},
        setError: () => {},
      }),
    [activeId],
  );
  const { runViews } = useSyncExternalStore(
    stream.subscribe,
    stream.getSnapshot,
    stream.getSnapshot,
  );
  useEffect(() => {
    stream.activate();
    if (rootEvents) void stream.streamRun(rootRunId);
    return stream.deactivate;
  }, [stream, rootEvents, rootRunId]);
  const nativeReadyKey = nativeSubagentReadyKey(runViews[rootRunId]);
  const observation = useNativeSubagents(
    'workspace',
    headers,
    { [activeId]: `initial/${nativeReadyKey}` },
    false,
  );
  const presentation = presentationPolicyFor(
    query.get('view') === 'verbose' ? 'verbose' : 'detailed',
    query.get('collapse') === 'next-input' ? 'next-input' : 'completion',
  );
  return (
    <main style={{ display: 'flex', minHeight: 600 }}>
      <nav
        aria-label="业务会话"
        style={{
          width: 230,
          height: 500,
          display: icons ? 'none' : 'flex',
          flexDirection: 'column',
        }}
      >
        <EmployeeSidebar
          workspace={workspace}
          sessions={
            query.has('transport-pressure')
              ? [
                  ...sessions,
                  {
                    ...sessions[0]!,
                    id: 'parent-d',
                    title: 'parent-d 父级任务',
                  },
                ]
              : sessions
          }
          activeId={activeId}
          nativeReadyKey={nativeReadyKey}
          nativeReads={observation.reads}
          collapsed={false}
          onSelectSession={setActiveId}
          onPrepareSession={() => {}}
          onDetails={() => {}}
        />
      </nav>
      <section style={{ minWidth: 0, flex: icons ? 1 : undefined }}>
        <header className={shellUi.conversationHeader}>
          <div className={conversationUi.titleRow}>
            <h1>{activeId} 父级任务</h1>
            <div
              className={`${conversationUi.headerActions} ${shellUi.conversationActions}`}
            >
              <NativeSubagentDirectory
                key={activeId}
                workspaceId="workspace"
                sessionId={activeId}
                headers={headers}
                observation={observation}
                viewerId={workspace.viewerId}
                canControl={controls && ownerId === workspace.viewerId}
                controlRoot={
                  controls
                    ? nativeSubagentControlRoot(runViews[rootRunId])
                    : undefined
                }
                presentation={presentation}
              />
              <WorkbenchEntries
                counts={{ files: 33, experience: 1, workflow: 0 }}
                experience
                workflow={icons && !query.has('no-workflow')}
                open={icons && selected !== null}
                selected={selected}
                onOpen={icons ? setSelected : () => {}}
                onToggle={() => {}}
              />
            </div>
          </div>
        </header>
        {icons && (
          <section aria-label="图标工作台">
            <WorkbenchStart
              experience
              workflow={!query.has('no-workflow')}
              onOpen={setSelected}
            />
            <output aria-label="当前工作台模块">
              {selected ? moduleLabels[selected] : '未选择'}
            </output>
          </section>
        )}
        {rootEvents && (
          <output aria-label="root事件游标">
            {runViews[rootRunId]?.cursor ?? 'empty'}
          </output>
        )}
        {controls && (
          <button
            style={{ position: 'fixed', bottom: 32, left: 0, zIndex: 90 }}
            onClick={() =>
              setControlRunId('55555555-5555-4555-8555-555555555555')
            }
          >
            切换根运行
          </button>
        )}
        {controls && (
          <button
            style={{ position: 'fixed', bottom: 0, left: 0, zIndex: 90 }}
            onClick={() =>
              setOwnerId((id) => (id === 'viewer' ? 'other' : 'viewer'))
            }
          >
            切换会话所有者
          </button>
        )}
      </section>
    </main>
  );
}
const theme = new URLSearchParams(location.search).get('theme');
if (theme === 'light' || theme === 'dark') applyTheme(theme);
createRoot(document.getElementById('root')!).render(<Page />);
