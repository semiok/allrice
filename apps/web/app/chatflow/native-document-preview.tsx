'use client';
import { memo, useEffect, useRef, useState } from 'react';
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
export const NativeDocumentPreview = memo(function NativeDocumentPreview({
  preview,
  fileName,
  pageUrl,
  headers = noHeaders,
  source = false,
  interactive = false,
  toolResult = false,
  active = true,
  onReadFailure,
}: {
  preview: ArtifactPreview;
  fileName: string;
  pageUrl?: string;
  headers?: Record<string, string>;
  source?: boolean;
  interactive?: boolean;
  toolResult?: boolean;
  active?: boolean;
  onReadFailure?: () => void;
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
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : '源文本读取失败');
          onReadFailure?.();
        }
      });
    return () => controller.abort();
  }, [sourceNeeded, pageUrl, headers, onReadFailure]);
  if (sourceNeeded) {
    if (error) return <p role="alert">{error}</p>;
    return sourcePage ? (
      <PagedDocumentText
        key={pageUrl}
        initial={sourcePage}
        fileName={fileName}
        pageUrl={pageUrl}
        headers={headers}
        active={active}
        onReadFailure={onReadFailure}
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
        active={active}
        onReadFailure={onReadFailure}
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
});
function PagedDocumentText({
  initial,
  fileName,
  pageUrl,
  headers,
  source,
  toolResult,
  active,
  onReadFailure,
}: {
  initial: TextPreview;
  fileName: string;
  pageUrl?: string;
  headers: Record<string, string>;
  source?: boolean;
  toolResult?: boolean;
  active: boolean;
  onReadFailure?: () => void;
}) {
  const [current, setCurrent] = useState({
    page: initial,
    firstPage: 1,
    fromEnd: false,
    history: [] as { offset: number; firstPage: number }[],
  });
  const { page, firstPage, history, fromEnd } = current;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    setCurrent({ page: initial, firstPage: 1, fromEnd: false, history: [] });
    setError('');
    setBusy(false);
    return () => request.current?.abort();
  }, [initial, pageUrl, headers]);
  async function load(direction: 'previous' | 'next', displayedPages = 0) {
    if (!pageUrl || busy) return;
    const previous = history.at(-1);
    if (direction === 'previous' && !previous) return;
    if (direction === 'next' && (page.eof !== false || !page.lines)) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const nextOffset =
        direction === 'previous'
          ? previous!.offset
          : (page.offset ?? 1) + page.lines!;
      const next = parseArtifactPreview(
        await workbenchJson(
          `${pageUrl}&source=1&offset=${nextOffset}`,
          headers,
          { signal: controller.signal },
        ),
      );
      if (controller.signal.aborted) return;
      if (next.kind !== 'text')
        throw Error(
          next.kind === 'download_only' ? next.reason : '文本分页读取失败',
        );
      if (next.offset !== nextOffset) throw Error('文本版本已变化，请刷新预览');
      // Keep only one authenticated read in memory and one small display page
      // in the DOM. Back navigation re-reads the same immutable version.
      setCurrent({
        page: next,
        firstPage:
          direction === 'previous'
            ? previous!.firstPage
            : firstPage + displayedPages,
        fromEnd: direction === 'previous',
        history:
          direction === 'previous'
            ? history.slice(0, -1)
            : [...history, { offset: page.offset ?? 1, firstPage }],
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(error instanceof Error ? error.message : '文本分页读取失败');
        onReadFailure?.();
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <>
      <DocumentText
        key={`${page.offset ?? 1}/${source ? 'source' : 'preview'}`}
        text={page.text}
        fileName={fileName}
        mediaType={page.mediaType}
        source={source}
        toolResult={toolResult}
        active={active}
        pagination={
          pageUrl && (history.length || page.eof === false)
            ? {
                firstPage,
                fromEnd,
                busy,
                previous: history.length
                  ? () => void load('previous')
                  : undefined,
                next:
                  page.eof === false && page.lines
                    ? (pages) => void load('next', pages)
                    : undefined,
              }
            : undefined
        }
      />
      {error && <p role="alert">{error}</p>}
    </>
  );
}
