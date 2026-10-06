import { createRoot } from 'react-dom/client';
import { PlatformRepositoryMerges } from '../app/runtime-console/platform-repository-merges';
const props = (
  window as unknown as {
    repositoryMergeFixture: {
      publicationId: string;
      credentialRevision: number | null;
    };
  }
).repositoryMergeFixture;
createRoot(document.getElementById('root')!).render(
  <PlatformRepositoryMerges {...props} />,
);
