// Isolated Chromium acceptance entry, not a Next route or production login.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArtifactWorkbench,
  ArtifactSummaryCards,
} from '../app/chatflow/artifact-workbench';
import { useArtifactWorkbench } from '../app/chatflow/use-artifact-workbench';
const input = JSON.parse(
  document.getElementById('p07-input')!.textContent!,
) as {
  sessionId: string;
  workspaceId: string;
  tenantHeaders: Record<string, string>;
};
function Fixture() {
  const w = useArtifactWorkbench({ ...input, enabled: true }),
    [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const m = matchMedia('(max-width:1100px)');
    const sync = () => setNarrow(m.matches);
    sync();
    m.addEventListener('change', sync);
    return () => m.removeEventListener('change', sync);
  }, []);
  return (
    <main
      style={{
        height: '100dvh',
        display: 'grid',
        gridTemplateColumns: w.open && !narrow ? 'minmax(0,1fr) 650px' : '1fr',
        overflow: 'hidden',
      }}
    >
      <section style={{ padding: 20, minWidth: 0 }}>
        <h1>合成 Session · 工件验收</h1>
        <button
          type="button"
          onClick={() => {
            if (!w.open) w.show();
          }}
        >
          工件与审查
        </button>
        <ArtifactSummaryCards
          artifacts={w.artifacts}
          onOpen={(id) => {
            if (w.confirmNavigation()) w.show(id);
          }}
        />
      </section>
      {w.open ? (
        <ArtifactWorkbench
          {...input}
          artifacts={w.artifacts}
          selectedId={w.selectedId}
          nextCursor={w.nextCursor}
          listError={w.error}
          listLoading={w.loading}
          narrow={narrow}
          onSelect={w.show}
          onClose={w.close}
          onReload={w.reload}
          onDirtyChange={w.noteDirty}
        />
      ) : null}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
