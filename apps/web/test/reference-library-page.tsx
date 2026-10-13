// Isolated UI entry for the real HTTP/database/Worker browser regression.
import { createRoot } from 'react-dom/client';
import { ReferenceLibrary } from '../app/chatflow/reference-library';
import { PlatformReferenceLibrary } from '../app/runtime-console/platform-reference-library';
const params = new URLSearchParams(window.location.search);
createRoot(document.getElementById('root')!).render(
  params.get('platform') === '1' ? (
    <PlatformReferenceLibrary />
  ) : (
    <ReferenceLibrary
      workspaceId={params.get('workspaceId')!}
      headers={{}}
      onClose={() => {}}
    />
  ),
);
