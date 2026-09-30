'use client';
import { useEffect, useRef, useState } from 'react';
import {
  parseArtifactPreview,
  workbenchJson,
  type ArtifactPreview,
  type TextPreview,
} from '../../lib/chatflow/workbench-model';
import { DocumentText } from './document-reader';
import { NativePdfPreview } from './native-pdf-preview';
import { NativeImagePreview } from './native-image-preview';
import { NativeExcelPreview } from './native-excel-preview';
import { NativeHtmlPreview } from './native-html-preview';
import { OfficePreview } from './office-preview';
import { LoadingIndicator } from './dsh-upstream/document/LoadingIndicator';
const noHeaders: Record<string, string> = {};
export function hasSourcePreview(preview: ArtifactPreview | null) {
  return (
    preview?.kind === 'text' ||
    preview?.kind === 'html' ||
    (preview?.kind === 'image' && preview.mediaType === 'image/svg+xml') ||
    (preview?.kind === 'spreadsheet' && ['csv', 'tsv'].includes(preview.format))
  );
}
export function hasNativeViewport(preview: ArtifactPreview | null) {
  return (
    preview &&
    ['pdf', 'office', 'spreadsheet', 'html', 'image'].includes(preview.kind)
  );
}
export function NativeDocumentPreview({
  preview,
  fileName,
  pageUrl,
  headers = noHeaders,
  source = false,
  interactive = false,
  toolResult = false,
}: {
  preview: ArtifactPreview;
  fileName: string;
  pageUrl?: string;
  headers?: Record<string, string>;
  source?: boolean;
  interactive?: boolean;
  toolResult?: boolean;
}) {
  const [sourcePage, setSourcePage] = useState<TextPreview>();
  const [error, setError] = useState('');
  const sourceNeeded =
    source && preview.kind !== 'text' && hasSourcePreview(preview);
  useEffect(() => {
    setSourcePage(undefined);
    setError('');
    if (!sourceNeeded || !pageUrl) return;
    const controller = new AbortController();
    void workbenchJson(`${pageUrl}&source=1`, headers, {
      signal: controller.signal,
    })
      .then(parseArtifactPreview)
      .then((value) => {
        if (controller.signal.aborted) return;
        if (value.kind !== 'text')
          throw Error(
            value.kind === 'download_only' ? value.reason : '源文本不可用',
          );
        setSourcePage(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : '源文本读取失败');
      });
    return () => controller.abort();
  }, [sourceNeeded, pageUrl, headers]);
  if (sourceNeeded) {
    if (error) return <p role="alert">{error}</p>;
    return sourcePage ? (
      <PagedDocumentText
        key={pageUrl}
        initial={sourcePage}
        fileName={fileName}
        pageUrl={pageUrl}
        headers={headers}
        source
      />
    ) : (
      <LoadingIndicator label="正在读取源文本…" />
    );
  }
  if (preview.kind === 'text')
    return (
      <PagedDocumentText
        key={pageUrl}
        initial={preview}
        fileName={fileName}
        pageUrl={pageUrl}
        headers={headers}
        source={source}
        toolResult={toolResult}
      />
    );
  if (preview.kind === 'spreadsheet')
    return (
      <NativeExcelPreview base64={preview.base64} format={preview.format} />
    );
  if (preview.kind === 'html')
    return (
      <NativeHtmlPreview base64={preview.base64} interactive={interactive} />
    );
  if (preview.kind === 'pdf')
    return <NativePdfPreview base64={preview.base64} />;
  if (preview.kind === 'image')
    return (
      <NativeImagePreview
        src={`data:${preview.mediaType};base64,${preview.base64}`}
        alt={fileName}
      />
    );
  if (preview.kind === 'office') return <OfficePreview preview={preview} />;
  if (preview.kind === 'download_only') return <p>{preview.reason}</p>;
  return null;
}
function PagedDocumentText({
  initial,
  fileName,
  pageUrl,
  headers,
  source,
  toolResult,
}: {
  initial: TextPreview;
  fileName: string;
  pageUrl?: string;
  headers: Record<string, string>;
  source?: boolean;
  toolResult?: boolean;
}) {
  const [page, setPage] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    setPage(initial);
    setError('');
  }, [initial]);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  async function more() {
    if (!pageUrl || busy || page.eof !== false || !page.lines) return;
    setBusy(true);
    setError('');
    try {
      const nextOffset = (page.offset ?? 1) + page.lines;
      const next = parseArtifactPreview(
        await workbenchJson(
          `${pageUrl}&source=1&offset=${nextOffset}`,
          headers,
          { signal: lifetime.current.signal },
        ),
      );
      if (next.kind !== 'text')
        throw Error(
          next.kind === 'download_only' ? next.reason : '文本分页读取失败',
        );
      if (next.offset !== nextOffset) throw Error('文本版本已变化，请刷新预览');
      setPage({
        ...next,
        text: page.text + (next.lines ? '\n' : '') + next.text,
      });
    } catch (error) {
      if (!lifetime.current.signal.aborted)
        setError(error instanceof Error ? error.message : '文本分页读取失败');
    } finally {
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  }
  return (
    <>
      <DocumentText
        text={page.text}
        fileName={fileName}
        mediaType={page.mediaType}
        source={source}
        toolResult={toolResult}
        streaming={page.eof === false}
      />
      {error && <p role="alert">{error}</p>}
      {page.eof === false && pageUrl && (
        <button type="button" disabled={busy} onClick={() => void more()}>
          {busy ? '正在加载…' : error ? '重试加载' : '加载更多内容'}
        </button>
      )}
    </>
  );
}
