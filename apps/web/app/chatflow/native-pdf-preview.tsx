'use client';
import * as React from 'react';
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit';
import {
  ZoomViewport,
  zoomSurfaceClass,
} from './dsh-upstream/document/zoom/ZoomViewport';
import {
  createPdfStore,
  type PdfState,
} from './dsh-upstream/document/pdf/store';
import { zh, type PdfLocaleKey } from './dsh-upstream/document/pdf/locales';
import styles from './workbench.module.css';
import { loadNativeDocumentModule } from './native-document-module';

type NativePdfProps = {
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
export function NativePdfPreview({ base64 }: { base64: string }) {
  const data = React.useMemo(
    () => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
    [base64],
  );
  const [module, setModule] = React.useState<PdfModule>();
  const [error, setError] = React.useState('');
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
  if (error)
    return (
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
    );
  if (!module) return <p role="status">正在加载 PDF 预览…</p>;
  const Body = module.PdfBody;
  return (
    <div className={styles.zoomPreview}>
      <Body
        content={{ kind: 'bytes', data }}
        useTabInfo={() => ({
          tab: { id: 'tab1' as TabId, signal: lifetime.signal },
        })}
        useStore={(select) => select(state)}
        actions={store.actions}
        retainTab={retain}
        ZoomViewport={ZoomViewport}
        zoomSurfaceClass={zoomSurfaceClass}
        scrollportRef={scrollport}
        t={(key, params) =>
          Object.entries(params ?? {}).reduce(
            (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
            zh[key] as string,
          )
        }
      />
    </div>
  );
}
