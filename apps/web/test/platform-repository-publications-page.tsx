import { createRoot } from 'react-dom/client';
import type { RepairTask } from '@allrice/database/technical-contracts';
import { PlatformRepositoryPublications } from '../app/runtime-console/platform-repository-publications';
const props = (
  window as unknown as {
    repositoryFixture: { repair: RepairTask; currentBaseline: boolean };
  }
).repositoryFixture;
createRoot(document.getElementById('root')!).render(
  <PlatformRepositoryPublications {...props} />,
);
