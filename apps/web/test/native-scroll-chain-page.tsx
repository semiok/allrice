// Real components in bounded reading seats; no database, model or private Excel DOM.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantMarkdown } from '../app/chatflow/assistant-markdown';
import { TechnicalDetails } from '../app/chatflow/technical-details';
import { PendingAttachmentRail } from '../app/chatflow/attachment-components';
import { EmployeeSidebar } from '../app/chatflow/employee-sidebar';
import { ReferenceSnapshotPreview } from '../app/chatflow/workbench-reference-preview';
import { DshDialog } from '../app/chatflow/dsh-upstream/Dialog';
import { CodeBlock } from '@deepseek-ai/dsh-client-ui-primitives';
import type { Session, Workspace } from '../app/chatflow/chatflow-types';
import styles from '../app/chatflow/dsh-saas.module.css';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '@allrice/ui/tokens.css';

const noop = () => {};
const headers = {};
const mode = new URLSearchParams(location.search).get('case');
const output = Array.from(
  { length: 90 },
  (_, index) => `输出第 ${index + 1} 行`,
).join('\n');
const code = 'native_scroll_data_'.repeat(180);
const table =
  '| 一 | 二 | 三 | 四 | 五 | 六 | 七 | 八 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |';
const sessions: Session[] = Array.from({ length: 25 }, (_, index) => ({
  id: `session-${index}`,
  title: `历史工作 ${index}`,
  employeeName: `员工 ${index}`,
  employeeAssignmentId: `employee-${index}`,
  employeeVersionId: 'version',
  ownerId: 'other-viewer',
  visibility: 'private',
  updatedAt: '2026-11-14T00:00:00Z',
  archivedAt: null,
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
const trailing = <p style={{ height: 1100, width: 1400 }}>继续阅读后续内容</p>;
function ToolOutput() {
  return (
    <TechnicalDetails>
      <pre aria-label="工具输出">{output}</pre>
    </TechnicalDetails>
  );
}
function Content() {
  if (mode === 'code')
    return (
      <CodeBlock
        code={code}
        lang="text"
        wrap={false}
        copyLabel="复制"
        copiedLabel="已复制"
        toolbarLabels={{
          codeLabel: '代码',
          wrapLabel: '自动换行',
          unwrapLabel: '取消换行',
        }}
      />
    );
  if (mode === 'table') return <AssistantMarkdown text={table} />;
  if (mode === 'tool' || mode === 'dialog') return <ToolOutput />;
  if (mode === 'reference')
    return (
      <div style={{ height: 220 }}>
        <ReferenceSnapshotPreview
          revisionId="fixture"
          title="引用资料.txt"
          workspaceId="workspace"
          headers={headers}
          active
        />
      </div>
    );
  if (mode === 'sidebar')
    return (
      <nav
        aria-label="员工侧栏"
        style={{ height: 220, display: 'flex', flexDirection: 'column' }}
      >
        <EmployeeSidebar
          workspace={workspace}
          sessions={sessions}
          activeId={null}
          nativeReads={{}}
          collapsed={false}
          onSelectSession={noop}
          onPrepareSession={noop}
        />
      </nav>
    );
  return (
    <PendingAttachmentRail
      disabled={false}
      onOpen={noop}
      onRemove={noop}
      onRetry={noop}
      attachments={Array.from({ length: 16 }, (_, index) => ({
        id: `file-${index}`,
        fileName: `附件-${index}.pdf`,
        mediaType: 'application/pdf',
        sizeBytes: 64,
        persistedId: `file-${index}`,
        status: 'ready',
        visibility: 'private',
      }))}
    />
  );
}
function Page() {
  const [open, setOpen] = useState(false);
  return (
    <main className={styles.shell}>
      {mode === 'dialog' ? (
        <>
          <button onClick={() => setOpen(true)}>打开弹框</button>
          {open && (
            <DshDialog
              ariaLabel="滚动资料"
              title="滚动资料"
              onClose={() => setOpen(false)}
            >
              <ToolOutput />
              {trailing}
            </DshDialog>
          )}
        </>
      ) : (
        <section
          aria-label="阅读面板"
          data-scroll-outer
          style={{
            margin: 16,
            height: 380,
            width: 'min(480px, calc(100vw - 32px))',
            overflow: 'auto',
          }}
        >
          <Content />
          {trailing}
        </section>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Page />);
