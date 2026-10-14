// Isolated UI entry for the real HTTP/database/Worker browser regression.
import '../app/styles/base.css';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { ReferenceLibrary } from '../app/chatflow/reference-library';
import { SaveArtifactReference } from '../app/chatflow/save-artifact-reference';
import { PlatformReferenceLibrary } from '../app/runtime-console/platform-reference-library';
const params = new URLSearchParams(window.location.search);
function ArtifactFixture() {
  const [library, setLibrary] = useState(false);
  const workspaceId = params.get('workspaceId')!;
  const headers = { 'x-workspace-id': workspaceId };
  return (
    <>
      <SaveArtifactReference
        workspaceId={workspaceId}
        headers={headers}
        versionId={params.get('artifactId')!}
        fileName="evidence.txt"
        version={1}
      />
      <button onClick={() => setLibrary(true)}>查看参考资料</button>
      {library && (
        <ReferenceLibrary
          workspaceId={workspaceId}
          headers={headers}
          onClose={() => setLibrary(false)}
        />
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  params.has('artifactId') ? (
    <ArtifactFixture />
  ) : params.get('platform') === '1' ? (
    <PlatformReferenceLibrary />
  ) : (
    <ReferenceLibrary
      workspaceId={params.get('workspaceId')!}
      headers={{}}
      onClose={() => {}}
    />
  ),
);
