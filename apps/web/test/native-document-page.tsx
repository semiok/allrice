import { createRoot } from 'react-dom/client';
import { StrictMode, useState } from 'react';
import { NativeDocumentPreview } from '../app/chatflow/native-document-preview';
import { parseArtifactPreview } from '../lib/chatflow/workbench-model';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
function Page() {
  const [items, setItems] = useState<
    {
      name: string;
      preview: unknown;
      source?: boolean;
      interactive?: boolean;
      pageUrl?: string;
    }[]
  >([]);
  Object.assign(window, { setPreviewItems: setItems });
  return (
    <div style={{ display: 'flex', height: '100dvh', minWidth: 0 }}>
      {items.map((item) => (
        <section
          key={item.name}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
          aria-label={item.name}
        >
          <NativeDocumentPreview
            preview={parseArtifactPreview(item.preview)}
            fileName={item.name}
            source={item.source}
            interactive={item.interactive}
            pageUrl={item.pageUrl}
          />
        </section>
      ))}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
