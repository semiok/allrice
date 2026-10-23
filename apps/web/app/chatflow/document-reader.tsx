'use client';

import { memo, useMemo, useState, type ReactNode } from 'react';
import {
  Button,
  CodeBlock,
  FileTypeIcon,
  IconDownloadOutlineRegular,
  IconEllipsisOutlineRegular,
  IconRefreshOutlineRegular,
  Menu,
  PathLabel,
  Tooltip,
  languageForPath,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { searchResultDocument } from '../../lib/chatflow/document-reader-model';
import { documentTextWindows } from '../../lib/chatflow/document-text-window';
import { AssistantMarkdown } from './assistant-markdown';
import native from './dsh-upstream/document/TextPreview.module.css';
import styles from './document-reader.module.css';
import { FontNotice } from './dsh-upstream/document/office/FontNotice';
import { zh as officeZh } from './dsh-upstream/document/office/locales';

/** DSH primitives and preview chrome; Allrice only supplies scoped file actions. */
export function DocumentToolbar(props: {
  title: string;
  downloadUrl: string;
  actions: MenuEntry[];
  onAction: (id: string) => void;
  children?: ReactNode;
  quickActions?: ReactNode;
  missingFonts?: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const refresh = props.actions.find(
    (action) => action.id === 'refresh' && 'label' in action,
  );
  const refreshLabel =
    refresh && 'label' in refresh && typeof refresh.label === 'string'
      ? refresh.label
      : '刷新文件';
  const menuActions = props.actions.filter((action) => action.id !== 'refresh');
  const hasMenuActions = menuActions.some((action) => 'label' in action);
  return (
    <header
      className={`${native.header} ${styles.toolbar}`}
      aria-label="文件操作"
    >
      <div className={styles.identity}>
        <FileTypeIcon path={props.title} size={20} />
        <PathLabel path={props.title} className={styles.name} />
      </div>
      <div className={styles.controls}>
        {props.children}
        {refresh && 'label' in refresh && (
          <Tooltip label={refreshLabel} side="bottom" delayMs={500} portal>
            <Button
              type="button"
              size="sm"
              className={styles.iconButton}
              aria-label={refreshLabel}
              disabled={refresh.disabled}
              onClick={() => {
                setOpen(false);
                props.onAction(refresh.id);
              }}
            >
              <IconRefreshOutlineRegular size={20} />
            </Button>
          </Tooltip>
        )}
        {props.quickActions}
        <FontNotice
          key={props.downloadUrl}
          fonts={props.missingFonts ?? []}
          t={(key, params) =>
            Object.entries(params ?? {}).reduce(
              (text, [name, value]) =>
                text.replaceAll(`{${name}}`, String(value)),
              officeZh[key] as string,
            )
          }
        />
        <Tooltip label="下载" side="bottom" delayMs={500} portal>
          <a
            className={styles.download}
            href={props.downloadUrl}
            download
            aria-label="下载"
          >
            <IconDownloadOutlineRegular size={20} />
          </a>
        </Tooltip>
        {hasMenuActions && (
          <Menu
            open={open}
            anchor={
              <Tooltip
                label="更多文件操作"
                side="bottom"
                delayMs={500}
                disabled={open}
                portal
              >
                <Button
                  type="button"
                  size="sm"
                  className={styles.iconButton}
                  aria-label="更多文件操作"
                  aria-haspopup="menu"
                  aria-expanded={open}
                  onClick={() => setOpen(!open)}
                >
                  <IconEllipsisOutlineRegular size={20} />
                </Button>
              </Tooltip>
            }
            items={menuActions}
            onSelect={(id) => {
              setOpen(false);
              props.onAction(id);
            }}
            onClose={() => setOpen(false)}
            align="end"
            portal
          />
        )}
      </div>
    </header>
  );
}

export const DocumentText = memo(function DocumentText(props: {
  text: string;
  fileName: string;
  mediaType: string;
  source?: boolean;
  toolResult?: boolean;
  streaming?: boolean;
  active?: boolean;
  pagination?: {
    firstPage: number;
    fromEnd?: boolean;
    busy: boolean;
    previous?: () => void;
    next?: (pages: number) => void;
  };
}) {
  const { search, language, pages, text } = useMemo(() => {
    const search = props.toolResult ? searchResultDocument(props.text) : null;
    let text = !props.source && search ? search.body : props.text;
    let language = languageForPath(props.fileName);
    if (props.source || (props.mediaType === 'application/json' && !search)) {
      try {
        text = JSON.stringify(JSON.parse(props.text), null, 2);
        language = 'json';
      } catch {
        /* Partial pages and plain text stay unchanged. */
      }
    }
    return { search, language, text, pages: documentTextWindows(text) };
  }, [
    props.text,
    props.fileName,
    props.mediaType,
    props.source,
    props.toolResult,
  ]);
  const [selection, setSelection] = useState<{ text: string; index: number }>();
  const index = Math.min(
    selection?.text === text
      ? selection.index
      : props.pagination?.fromEnd
        ? pages.length - 1
        : 0,
    pages.length - 1,
  );
  const paginated = pages.length > 1 || !!props.pagination;
  const rendered =
    !props.source && (props.mediaType === 'text/markdown' || !!search);
  // Keep the page selection, but remove hidden token/Markdown nodes.
  if (props.active === false) return null;
  return (
    <section
      className={styles.text}
      aria-label={props.source ? '源文本' : '文件正文'}
    >
      {paginated && (
        <nav className={styles.pagination} aria-label="文本分页">
          <button
            type="button"
            disabled={
              props.pagination?.busy || (!index && !props.pagination?.previous)
            }
            onClick={() =>
              index
                ? setSelection({ text, index: index - 1 })
                : props.pagination?.previous?.()
            }
          >
            上一页
          </button>
          <span>第 {(props.pagination?.firstPage ?? 1) + index} 页</span>
          <button
            type="button"
            disabled={
              props.pagination?.busy ||
              (index === pages.length - 1 && !props.pagination?.next)
            }
            onClick={() =>
              index < pages.length - 1
                ? setSelection({ text, index: index + 1 })
                : props.pagination?.next?.(pages.length)
            }
          >
            {props.pagination?.busy ? '正在加载…' : '下一页'}
          </button>
        </nav>
      )}
      {search && !props.source ? (
        <p className={styles.sourceNotice}>搜索资料 · {search.query}</p>
      ) : null}
      {rendered ? (
        <AssistantMarkdown
          text={pages[index]!}
          allowRemoteImages
          streaming={props.streaming}
        />
      ) : (
        <CodeBlock
          className={styles.code}
          code={pages[index]!}
          streaming={props.streaming}
          lang={language}
          lineNumbers
          wrap
          copyLabel={paginated ? '复制本页' : '复制文本'}
          copiedLabel="已复制"
          toolbarLabels={{
            codeLabel: '代码',
            wrapLabel: '自动换行',
            unwrapLabel: '取消换行',
          }}
        />
      )}
    </section>
  );
});
