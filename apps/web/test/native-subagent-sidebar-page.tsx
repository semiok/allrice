import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EmployeeSidebar } from '../app/chatflow/employee-sidebar';
import type { Session, Workspace } from '../app/chatflow/chatflow-types';

const state = new URLSearchParams(location.search).get('state');
const sessions: Session[] = ['parent-a', 'parent-b', 'parent-c'].map((id) => ({
  id,
  title: `${id} 父级任务`,
  ownerId: 'viewer',
  employeeAssignmentId: 'employee',
  employeeVersionId: 'version',
  visibility: 'private',
  updatedAt: '2026-10-30T00:00:00Z',
  archivedAt: null,
  running: state === 'running',
  ...(state === 'pending' ? { pendingInteraction: 'question' as const } : {}),
}));
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
function Page() {
  const [activeId, setActiveId] = useState('parent-a');
  return (
    <nav
      aria-label="业务会话"
      style={{
        width: 250,
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
        scheduledSessions={new Set(['parent-b'])}
      />
    </nav>
  );
}
createRoot(document.getElementById('root')!).render(<Page />);
