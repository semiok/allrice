import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CodexAuthorizationPanel,
  type CodexAuthorization,
} from '../app/runtime-console/codex-authorization';
import styles from '../app/runtime-console/governance-console.module.css';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/styles/base.css';
function Fixture() {
  const [authorization, setAuthorization] = useState<CodexAuthorization | null>(
    location.search.includes('failed')
      ? {
          id: 'failed-flow',
          state: 'failed',
          userCode: null,
          verificationUri: null,
          detailCode: 'dsh_openai_codex_authorization_network_unavailable',
        }
      : null,
  );
  return (
    <main className={styles.embedded}>
      <div className={styles.codexAuth}>
        <CodexAuthorizationPanel
          status={
            location.search.includes('disconnected')
              ? 'disconnected'
              : 'connected'
          }
          authorization={authorization}
          busy={false}
          onStart={() => {
            document.body.dataset.starts = String(
              Number(document.body.dataset.starts ?? 0) + 1,
            );
            setAuthorization({
              id: 'synthetic',
              state: 'awaiting_user',
              userCode: 'TEST-CODE',
              verificationUri: 'https://auth.openai.com/codex/device',
            });
          }}
          onCancel={() => setAuthorization(null)}
        />
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
