'use client';
/**
 * Adapted from Cline ToolFileDiff, Apache-2.0.
 * Copyright 2026 Cline Bot Inc.
 * Source: cline/cline@dac3b35ba485dbab3b5a73aca239b0d07ce071cf
 * sdk/packages/ui/components/agent-chat/tool-diff.tsx
 * Modified by AllRice: exact bytes/EOF (no added newline), deleted files,
 * bounded input, finite render-recovery with visible fallback, explicit theme,
 * responsive split/unified views and version-aware selection. No editor/approval.
 * See THIRD_PARTY_NOTICES.md and the repository LICENSE.
 */
import { parseDiffFromFile } from '@pierre/diffs';
import {
  FileDiff,
  type FileDiffProps,
  type SelectedLineRange,
} from '@pierre/diffs/react';
import {
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { boundedRichDiff } from '../../../lib/chatflow/workbench-model';

export function parseBoundedDiff(
  path: string,
  before: string | null,
  after: string | null,
) {
  if (!boundedRichDiff(before, after)) return null;
  try {
    // Pinned Pierre forwards these options to diff@9's createTwoFilesPatch.
    // Its public non-abortable type omits limits; an aborted parse throws in
    // Pierre and is deliberately converted to a visible fallback.
    const parseOptions = { context: 3, timeout: 500, maxEditLength: 3000 };
    return parseDiffFromFile(
      before === null ? null : { name: path, contents: before },
      after === null ? null : { name: path, contents: after },
      parseOptions,
    );
  } catch {
    return null;
  }
}

export function ToolFileDiff({
  path,
  before,
  after,
  onSelect,
  mode,
}: {
  path: string;
  before: string | null;
  after: string | null;
  mode: 'split' | 'unified';
  onSelect: (side: 'before' | 'after', start: number, end: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    [attempt, setAttempt] = useState(0),
    [failed, setFailed] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const canRender = boundedRichDiff(before, after);
  const diff = useMemo(
    () => parseBoundedDiff(path, before, after),
    [before, after, path],
  );
  const options = useMemo<
    NonNullable<FileDiffProps<undefined, undefined>['options']>
  >(
    () => ({
      diffStyle: mode,
      disableFileHeader: true,
      themeType: theme,
      overflow: 'scroll',
      tokenizeMaxLength: 120_000,
      tokenizeMaxLineLength: 4000,
      lineDiffType: 'word',
      maxLineDiffLength: 2000,
      expansionLineCount: 50,
      enableLineSelection: true,
      onLineSelected(range: SelectedLineRange | null) {
        if (range && (!range.endSide || range.endSide === range.side))
          onSelect(
            range.side === 'deletions' ? 'before' : 'after',
            Math.min(range.start, range.end),
            Math.max(range.start, range.end),
          );
      },
    }),
    [mode, theme, onSelect],
  );
  useEffect(() => {
    const sync = () =>
      setTheme(
        document.documentElement.dataset.theme === 'dark' ||
          document.documentElement.classList.contains('dark')
          ? 'dark'
          : 'light',
      );
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!diff) return;
    const timer = window.setTimeout(() => {
      const tree = host.current?.querySelector('diffs-container')?.shadowRoot;
      if (!tree?.querySelector('style[data-theme-css]')) {
        if (attempt < 3) setAttempt((v) => v + 1);
        else setFailed(true);
      }
    }, 600);
    return () => window.clearTimeout(timer);
  }, [diff, attempt]);
  if (!canRender)
    return (
      <p role="status">
        文件过长，已停用富 Diff。可下载精确工件，或按下方行号提交意见。
      </p>
    );
  if (failed || !diff)
    return (
      <p role="status">
        {before === after
          ? '该文件内容没有差异。'
          : 'Diff 暂不可用，请使用前后文本视图或下载工件。'}
      </p>
    );
  return (
    <div ref={host} data-cline-diff>
      <FileDiff
        key={attempt}
        fileDiff={diff}
        options={options}
        disableWorkerPool
        style={
          {
            '--diffs-light-bg': '#fff',
            '--diffs-dark-bg': '#191b1e',
            '--diffs-font-size': '12px',
            colorScheme: theme,
          } as CSSProperties
        }
      />
    </div>
  );
}
