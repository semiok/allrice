'use client';
import * as React from 'react';
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit';
import {
  ZoomViewport,
  zoomSurfaceClass,
  type ZoomViewportProps,
} from './dsh-upstream/document/zoom/ZoomViewport';
import {
  createPdfStore,
  type PdfState,
} from './dsh-upstream/document/pdf/store';
import { zh, type PdfLocaleKey } from './dsh-upstream/document/pdf/locales';
import styles from './workbench.module.css';
import reader from './document-reader.module.css';
import { loadNativeDocumentModule } from './native-document-module';
import { LoadingIndicator } from './dsh-upstream/document/LoadingIndicator';

type NativePdfProps = {
  loading: React.ReactNode;
  content: { kind: 'bytes'; data: Uint8Array<ArrayBuffer> };
  useTabInfo: () => { tab: { id: TabId; signal: AbortSignal } };
  useStore: <T>(select: (state: PdfState) => T) => T;
  actions: ReturnType<ReturnType<typeof createPdfStore>['create']>['actions'];
  retainTab: (id: TabId, signal: AbortSignal) => void;
  ZoomViewport: typeof ZoomViewport;
  zoomSurfaceClass: string;
  scrollportRef: (element: HTMLElement | null) => void;
  t: (key: PdfLocaleKey, params?: Record<string, string | number>) => string;
};
type PdfModule = { PdfBody: React.ComponentType<NativePdfProps> };
const loadPdf = () => loadNativeDocumentModule<PdfModule>('pdf');
const retain = () => {};
const scrollport = () => {};
const PdfFooterContext = React.createContext<{
  footer: React.ReactNode;
  setViewportMounted: (mounted: boolean) => void;
} | null>(null);

/** Use the native viewport injection seat; only document surfaces are zoomed. */
function PdfFooterViewport(props: ZoomViewportProps) {
  const integration = React.useContext(PdfFooterContext);
  const setViewportMounted = integration?.setViewportMounted;
  React.useLayoutEffect(() => {
    setViewportMounted?.(true);
    return () => setViewportMounted?.(false);
  }, [setViewportMounted]);
  return (
    <ZoomViewport {...props}>
      <div className={reader.pdfPages}>{props.children}</div>
      <div className={reader.pdfFooter}>{integration?.footer}</div>
    </ZoomViewport>
  );
}

export function NativePdfPreview({
  base64,
  footer,
}: {
  base64: string;
  footer?: React.ReactNode;
}) {
  const data = React.useMemo(
    () => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
    [base64],
  );
  const [module, setModule] = React.useState<PdfModule>();
  const [error, setError] = React.useState('');
  const [viewportMounted, setViewportMounted] = React.useState(false);
  const integration = React.useMemo(
    () => ({ footer, setViewportMounted }),
    [footer],
  );
  const [store] = React.useState(() => createPdfStore().create());
  const state = React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const [lifetime, setLifetime] = React.useState(() => new AbortController());
  React.useEffect(() => {
    if (lifetime.signal.aborted) {
      setLifetime(new AbortController());
      return;
    }
    void loadPdf()
      .then((value) => {
        if (!lifetime.signal.aborted) setModule(value);
      })
      .catch((error) => {
        if (!lifetime.signal.aborted)
          setError(error instanceof Error ? error.message : 'PDF 预览不可用');
      });
    return () => lifetime.abort();
  }, [lifetime]);
  const Body = module?.PdfBody;
  const body = error ? (
    <div role="alert">
      {error}
      <button
        type="button"
        onClick={() => {
          setError('');
          setLifetime(new AbortController());
        }}
      >
        重新加载
      </button>
    </div>
  ) : Body ? (
    <Body
      loading={<LoadingIndicator label={zh.loading} />}
      content={{ kind: 'bytes', data }}
      useTabInfo={() => ({
        tab: { id: 'tab1' as TabId, signal: lifetime.signal },
      })}
      useStore={(select) => select(state)}
      actions={store.actions}
      retainTab={retain}
      ZoomViewport={footer ? PdfFooterViewport : ZoomViewport}
      zoomSurfaceClass={zoomSurfaceClass}
      scrollportRef={scrollport}
      t={(key, params) =>
        Object.entries(params ?? {}).reduce(
          (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
          zh[key] as string,
        )
      }
    />
  ) : (
    <p role="status">正在加载 PDF 预览…</p>
  );
  if (!footer && (!Body || error)) return body;
  return footer ? (
    <PdfFooterContext.Provider value={integration}>
      <div className={`${styles.zoomPreview} ${reader.pdfWithFooter}`}>
        <div className={reader.pdfRenderer}>{body}</div>
        {!viewportMounted && footer}
      </div>
    </PdfFooterContext.Provider>
  ) : (
    <div className={styles.zoomPreview}>{body}</div>
  );
}
