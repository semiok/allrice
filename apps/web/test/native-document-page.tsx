import { createRoot } from 'react-dom/client';
import { StrictMode, useState } from 'react';
import { DocumentToolbar } from '../app/chatflow/document-reader';
import { NativeDocumentPreview } from '../app/chatflow/native-document-preview';
import { NativeHtmlPreview } from '../app/chatflow/native-html-preview';
import { parseArtifactPreview } from '../lib/chatflow/workbench-model';
import workbench from '../app/chatflow/workbench.module.css';
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
      liveSrc?: string;
    }[]
  >([]);
  Object.assign(window, { setPreviewItems: setItems });
  return (
    <div style={{ display: 'flex', height: '100dvh', minWidth: 0 }}>
      {items.map((item) => {
        const preview = parseArtifactPreview(item.preview);
        return (
          <section
            key={item.name}
            className={workbench.panel}
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
            aria-label={item.name}
          >
            <DocumentToolbar
              title={item.name}
              downloadUrl={'/download/' + item.name}
              actions={[]}
              onAction={() => {}}
              missingFonts={
                preview.kind === 'pdf' ? preview.missingFonts : undefined
              }
            />
            {item.liveSrc ? (
              <NativeHtmlPreview liveSrc={item.liveSrc} />
            ) : (
              <NativeDocumentPreview
                preview={preview}
                fileName={item.name}
                source={item.source}
                interactive={item.interactive}
                pageUrl={item.pageUrl}
              />
            )}
          </section>
        );
      })}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
