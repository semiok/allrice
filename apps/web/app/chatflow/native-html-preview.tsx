'use client';
import { useEffect, useMemo, useState } from 'react';
import { previewBytes } from './native-document-module';
import { createBasicHtmlDocument } from './dsh-upstream/document/html/basic-document';
import { createHtmlDocument } from './dsh-upstream/document/html/bootstrap';
import {
  packHtml,
  type ReadHtmlRelative,
} from './dsh-upstream/document/html/pack';
import { LoadingIndicator } from './dsh-upstream/document/LoadingIndicator';
import native from './dsh-upstream/document/html/HtmlBody.module.css';
const missingRelated: ReadHtmlRelative = async () => {
  throw Error('关联文件不可用');
};
/** Native HTML packing and iframe isolation. The host reader only resolves files
 * explicitly related to the authorized source; the frame receives no host bridge. */
export function NativeHtmlPreview({
  base64 = '',
  interactive = false,
  readRelative = missingRelated,
  liveSrc,
}: {
  base64?: string;
  liveSrc?: string;
  interactive?: boolean;
  readRelative?: ReadHtmlRelative;
}) {
  const data = useMemo(() => previewBytes(base64), [base64]);
  const [frame, setFrame] = useState<{
    data: typeof data;
    interactive: boolean;
    url?: string;
    html?: string;
    error?: string;
  }>();
  useEffect(() => {
    if (liveSrc) return;
    const controller = new AbortController();
    let url: string | undefined;
    void (async () => {
      try {
        if (interactive) {
          const bundle = await packHtml(data, readRelative, controller.signal);
          controller.signal.throwIfAborted();
          url = URL.createObjectURL(
            new Blob([createHtmlDocument(bundle)], { type: 'text/html' }),
          );
          setFrame({ data, interactive, url });
        } else
          setFrame({ data, interactive, html: createBasicHtmlDocument(data) });
      } catch {
        if (!controller.signal.aborted)
          setFrame({
            data,
            interactive,
            error: '网页预览失败，请检查内容或关联文件。',
          });
      }
    })();
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [data, interactive, readRelative, liveSrc]);
  if (liveSrc) {
    const url = new URL(liveSrc);
    if (
      !url.hostname.startsWith('rice-preview-') ||
      url.username ||
      url.password ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && url.hostname.endsWith('.localhost'))) ||
      (typeof window !== 'undefined' && url.origin === window.location.origin)
    )
      return <p role="alert">项目预览地址不可用。</p>;
    return (
      <iframe
        key={liveSrc}
        className={native.frame}
        src={liveSrc}
        sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
        referrerPolicy="no-referrer"
        title="项目实时预览"
        data-html-preview
        data-project-service-preview
      />
    );
  }
  if (frame?.data !== data || frame.interactive !== interactive)
    return <LoadingIndicator label="正在打开网页…" />;
  if (frame.error) return <p role="alert">{frame.error}</p>;
  return (
    <iframe
      key={frame.url ?? 'static'}
      className={native.frame}
      src={frame.url}
      srcDoc={frame.html}
      sandbox={interactive ? 'allow-scripts' : ''}
      title="网页预览"
      data-html-preview
    />
  );
}
