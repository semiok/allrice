import { createRoot } from 'react-dom/client';
import { PlatformModelSettingsPanel } from '../app/runtime-console/platform-model-settings';
import styles from '../app/runtime-console/governance-console.module.css';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/styles/base.css';
createRoot(document.getElementById('root')!).render(
  <main className={styles.embedded}>
    <PlatformModelSettingsPanel />
  </main>,
);
