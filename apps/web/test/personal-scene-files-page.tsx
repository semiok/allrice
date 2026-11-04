import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { PersonalSceneFilePanel } from '../app/chatflow/personal-scene-files';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../../../packages/ui/src/tokens.css';

const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function Page() {
  const [other, setOther] = useState(false);
  return (
    <main
      style={{
        maxWidth: 1080,
        margin: '20px auto',
        padding: 16,
        color: 'var(--ar-text)',
        font: 'var(--ar-font-body)',
      }}
    >
      <button type="button" onClick={() => setOther((value) => !value)}>
        切换另一员工
      </button>
      <h2>我的周报助理</h2>
      <PersonalSceneFilePanel
        scopeId={other ? 'viewer-B' : 'viewer-A'}
        instanceId={id(other ? 2 : 1)}
        workspaceId={id(10)}
        headers={{}}
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Page />);
