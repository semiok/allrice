import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CodexSubscriptionsPanel,
  type CodexSubscriptionAccount,
} from '../app/runtime-console/codex-subscriptions';
import styles from '../app/runtime-console/governance-console.module.css';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/styles/base.css';
function Fixture() {
  const [accounts, setAccounts] = useState<CodexSubscriptionAccount[]>(
    [1, 2].map((slot) => ({
      slot: slot as 1 | 2,
      label: slot === 1 ? 'metasnowsky' : 'encorealpha',
      enabled: slot === 1,
      authorization: null,
      provider: {
        provider: 'codex',
        authMode: 'chatgpt_subscription',
        status: slot === 1 ? 'connected' : 'disconnected',
        cliVersion: null,
        detailCode: null,
        checkedAt: null,
        quota: null,
      },
    })),
  );
  return (
    <main className={styles.embedded}>
      <div className={styles.codexAuth}>
        <CodexSubscriptionsPanel
          accounts={accounts}
          busy={false}
          onSelect={(slot) =>
            setAccounts((old) =>
              old.map((a) => ({ ...a, enabled: a.slot === slot })),
            )
          }
          onAuthorize={(slot) => {
            document.body.dataset.authorizing = String(slot);
            setAccounts((old) =>
              old.map((a) =>
                a.slot === slot
                  ? { ...a, provider: { ...a.provider, status: 'connected' } }
                  : a,
              ),
            );
          }}
          onCancel={() => {}}
        />
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
