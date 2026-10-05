// Real UI components over the isolated PostgreSQL fixture's authorized HTTP.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ChatMessageSchema,
  TaskNextStepsSchema,
  type TaskNextSteps,
} from '@allrice/contracts';
import { ArtifactWorkbench } from '../app/chatflow/artifact-workbench';
import { useArtifactWorkbench } from '../app/chatflow/use-artifact-workbench';
import { ChatTranscript } from '../app/chatflow/chat-transcript';
import { TaskSuggestions } from '../app/chatflow/task-suggestions';
import type { Message } from '../app/chatflow/chatflow-types';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
const input = JSON.parse(
  document.getElementById('fixture-input')!.textContent!,
) as {
  sessionId: string;
  workspaceId: string;
  tenantHeaders: Record<string, string>;
};
function Fixture() {
  const [open, setOpen] = useState(false),
    [facts, setFacts] = useState<{
      messages: Message[];
      next: TaskNextSteps;
    } | null>(null);
  const onOpen = useCallback(() => setOpen(true), []),
    onClose = useCallback(() => setOpen(false), []);
  const w = useArtifactWorkbench({ ...input, enabled: true, onOpen, onClose });
  const transcript = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const abort = new AbortController();
    void fetch('/fixture/facts', { signal: abort.signal })
      .then((r) => r.json())
      .then((body) => {
        if (!abort.signal.aborted)
          setFacts({
            messages: ChatMessageSchema.array()
              .parse(body.messages)
              .map((m) => ({ ...m, attachments: [] })),
            next: TaskNextStepsSchema.parse(body.next),
          });
      });
    return () => abort.abort();
  }, []);
  return (
    <main
      style={{
        height: '100dvh',
        display: 'grid',
        gridTemplateColumns: open ? 'minmax(0,1fr) 620px' : '1fr',
      }}
    >
      <section style={{ padding: 20 }}>
        <div ref={transcript}>
          {facts && (
            <ChatTranscript
              atBottom
              employeeName="Fixture"
              messages={facts.messages}
              runTraces={{}}
              runViews={{}}
              tenantHeaders={input.tenantHeaders}
              transcriptColumn={transcript}
              workspaceId={input.workspaceId}
              onLoadRunTrace={() => {}}
              onRecoverRun={() => {}}
              onScrollToBottom={() => {}}
              artifacts={w.artifacts}
              onOpenArtifact={w.show}
            />
          )}
        </div>
        {facts && (
          <TaskSuggestions
            suggestions={[]}
            draft=""
            busy={false}
            compact
            attachmentCount={0}
            readiness={null}
            onPrepare={() => {}}
            onPreparation={() => {}}
            nextSteps={facts.next}
          />
        )}
      </section>
      {open && (
        <ArtifactWorkbench
          open
          width={620}
          {...input}
          dockScope={`fixture/${input.sessionId}`}
          artifacts={w.artifacts}
          selectedId={w.selectedId}
          nextCursor={w.nextCursor}
          listError={w.error}
          listLoading={w.loading}
          narrow={false}
          onSelect={w.show}
          onClose={w.close}
          onReload={w.reload}
          readOnly
        />
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
