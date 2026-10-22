'use client';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';
import uiSource from '../dsh-upstream/upstream.json';
import { loadNativeClientModule } from './native-client-module';

type Chunk = 'pdf' | 'excel';
/** Serialize native chunk registration so simultaneous PDF and Excel tabs cannot
 * replace one another's loader. Only pinned, locally served assets are accepted. */
export function loadNativeDocumentModule<T>(chunk: Chunk): Promise<T> {
  const version = uiSource.componentSets.find(
    (g) => g.id === 'native-document',
  )!.version;
  return loadNativeClientModule({
    packageId: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview',
    chunk: `client.${chunk}.js`,
    url: `/api/dsh-ui/${chunk}?version=${encodeURIComponent(version)}`,
    dependencies: {
      react: React,
      'react/jsx-runtime': jsxRuntime,
      '@deepseek-ai/dsh-client-ui-primitives': primitives,
    },
  });
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
