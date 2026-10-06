import { createRoot } from 'react-dom/client';
import { PlatformRepositoryReviews } from '../app/runtime-console/platform-repository-reviews';
const props = (
  window as unknown as {
    repositoryReviewFixture: {
      publicationId: string;
      credentialRevision: number | null;
    };
  }
).repositoryReviewFixture;
createRoot(document.getElementById('root')!).render(
  <PlatformRepositoryReviews {...props} />,
);
