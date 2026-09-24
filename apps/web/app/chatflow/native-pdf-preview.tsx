'use client';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';
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
let loaded: Promise<PdfModule> | undefined;
/** Only the official PDF chunk registers here; no DSH filesystem, services or agent is started. */
function loadPdf(): Promise<PdfModule> {
  return (loaded ??= new Promise<PdfModule>((resolve, reject) => {
    const previous = Reflect.get(window, '__ModuleLoader__');
    let result: PdfModule | undefined;
    let failure: unknown;
    const facade = {
      load(registration: {
        id: string;
        chunk: string;
        factory: (require: (id: string) => unknown) => unknown;
      }) {
        try {
          if (
            registration.id !==
              '@deepseek-ai/dsh-client-ui-sidebar-documentpreview' ||
            registration.chunk !== 'client.pdf.js'
          )
            throw Error('预览组件来源不匹配');
          result = registration.factory((id) => {
            if (id === 'react') return React;
            if (id === 'react/jsx-runtime') return jsxRuntime;
            if (id === '@deepseek-ai/dsh-client-ui-primitives')
              return primitives;
            throw Error(`预览组件依赖不可用：${id}`);
          }) as PdfModule;
        } catch (error) {
          failure = error;
        }
      },
    };
    Reflect.set(window, '__ModuleLoader__', facade);
    const script = document.createElement('script');
    script.src = '/api/dsh-ui/pdf?version=0.1.7-rc.1';
    const restore = () => {
      if (Reflect.get(window, '__ModuleLoader__') === facade) {
        if (previous === undefined)
          Reflect.deleteProperty(window, '__ModuleLoader__');
        else Reflect.set(window, '__ModuleLoader__', previous);
      }
      script.remove();
    };
    script.onload = () => {
      restore();
      if (result?.PdfBody) resolve(result);
      else reject(failure ?? Error('PDF 预览组件未就绪'));
    };
    script.onerror = () => {
      restore();
      reject(Error('PDF 预览组件加载失败'));
    };
    document.head.append(script);
  }).catch((error) => {
    loaded = undefined;
    throw error;
  }));
}
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
