'use client';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';
import uiSource from '../dsh-upstream/upstream.json';

type Chunk = 'pdf' | 'excel';
const modules = new Map<Chunk, Promise<unknown>>();
let pending: Promise<unknown> = Promise.resolve();
/** Serialize native chunk registration so simultaneous PDF and Excel tabs cannot
 * replace one another's loader. Only pinned, locally served assets are accepted. */
export function loadNativeDocumentModule<T>(chunk: Chunk): Promise<T> {
  let loaded = modules.get(chunk);
  if (!loaded) {
    loaded = pending
      .catch(() => undefined)
      .then(
        () =>
          new Promise<unknown>((resolve, reject) => {
            const previous = Reflect.get(window, '__ModuleLoader__');
            let result: unknown, failure: unknown;
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
                    registration.chunk !== `client.${chunk}.js`
                  )
                    throw Error('预览组件来源不匹配');
                  result = registration.factory((id) => {
                    if (id === 'react') return React;
                    if (id === 'react/jsx-runtime') return jsxRuntime;
                    if (id === '@deepseek-ai/dsh-client-ui-primitives')
                      return primitives;
                    throw Error(`预览组件依赖不可用：${id}`);
                  });
                } catch (error) {
                  failure = error;
                }
              },
            };
            Reflect.set(window, '__ModuleLoader__', facade);
            const script = document.createElement('script');
            const version = uiSource.componentSets.find(
              (g) => g.id === 'native-document',
            )!.version;
            script.src = `/api/dsh-ui/${chunk}?version=${encodeURIComponent(version)}`;
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
              if (result) resolve(result);
              else reject(failure ?? Error('预览组件未就绪'));
            };
            script.onerror = () => {
              restore();
              reject(Error('预览组件加载失败'));
            };
            document.head.append(script);
          }),
      )
      .catch((error) => {
        modules.delete(chunk);
        throw error;
      });
    modules.set(chunk, loaded);
    pending = loaded.catch(() => undefined);
  }
  return loaded as Promise<T>;
}
export function previewBytes(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}
export function previewLocale(dictionary: Record<string, string>) {
  return (key: string, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
      dictionary[key] ?? key,
    );
}
