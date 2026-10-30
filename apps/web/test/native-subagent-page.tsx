import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EmployeeSidebar } from '../app/chatflow/employee-sidebar';
import { NativeSubagentDirectory } from '../app/chatflow/native-subagent-directory';
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
  return (
    <main style={{ display: 'flex', minHeight: 600 }}>
      <nav
        aria-label="业务会话"
        style={{
          width: 230,
          height: 500,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <EmployeeSidebar
          workspace={workspace}
          sessions={sessions}
          activeId={activeId}
          collapsed={false}
          onSelectSession={setActiveId}
          onPrepareSession={() => {}}
          onDetails={() => {}}
        />
      </nav>
      <section style={{ minWidth: 0 }}>
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
                refreshKey="initial"
              />
            </div>
          </div>
        </header>
      </section>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Page />);
