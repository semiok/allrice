'use client';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Ref,
  type ReactNode,
} from 'react';
import {
  IconFolderOpenOutlineRegular,
  IconClockOutlineRegular,
  IconPanelLeftOutlineRegular,
  IconChevronRightOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { z } from 'zod';
import { workbenchJson } from '../../lib/chatflow/workbench-model';
import css from './workbench-modules.module.css';
export type WorkbenchModule = 'files' | 'experience' | 'workflow';
export const moduleLabels = {
  files: '工作区文件',
  experience: '经验管理',
  workflow: '工作流',
};
export function WorkbenchIcon({
  kind,
  size = 20,
}: {
  kind:
    | WorkbenchModule
    | 'panel'
    | 'fullscreen'
    | 'restore'
    | 'start'
    | 'schedule'
    | 'chevron-right';
  size?: number;
}) {
  if (kind === 'files')
    return <IconFolderOpenOutlineRegular size={size} className={css.glyph} />;
  if (kind === 'schedule')
    return <IconClockOutlineRegular size={size} className={css.glyph} />;
  if (kind === 'panel')
    return (
      <IconPanelLeftOutlineRegular
        size={size}
        className={`${css.glyph} ${css.panelGlyph}`}
      />
    );
  if (kind === 'chevron-right')
    return <IconChevronRightOutlineRegular size={size} className={css.glyph} />;
  return (
    <svg
      className={css.glyph}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'experience' ? (
        <>
          <path d="M12 5a3 3 0 0 0-5.8-1 4 4 0 0 0-3 6.5A4 4 0 0 0 5 18a3.5 3.5 0 0 0 7 1V5Zm0 0a3 3 0 0 1 5.8-1 4 4 0 0 1 3 6.5A4 4 0 0 1 19 18a3.5 3.5 0 0 1-7 1" />
          <path d="M8 8a3 3 0 0 1-3-2m11 2a3 3 0 0 0 3-2M7 13a3 3 0 0 0-3 1m13-1a3 3 0 0 1 3 1M8 17a3 3 0 0 0 1-3m7 3a3 3 0 0 1-1-3" />
        </>
      ) : kind === 'workflow' ? (
        <>
          <rect x="3" y="3" width="7" height="6" rx="1.5" />
          <rect x="14" y="15" width="7" height="6" rx="1.5" />
          <rect x="3" y="15" width="7" height="6" rx="1.5" />
          <path d="M6.5 9v6M10 6h7.5v9" />
        </>
      ) : kind === 'start' ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m16 8-2.5 5.5L8 16l2.5-5.5L16 8Z" />
        </>
      ) : kind === 'restore' ? (
        <path d="M9 3v6H3m12-6v6h6M9 21v-6H3m12 6v-6h6" />
      ) : (
        <path d="M9 3H3v6m12-6h6v6M9 21H3v-6m12 6h6v-6" />
      )}
    </svg>
  );
}
export function WorkbenchEntries(props: {
  counts: Record<WorkbenchModule, number>;
  workflow: boolean;
  experience: boolean;
  open: boolean;
  selected?: WorkbenchModule | 'schedule' | null;
  schedule?: boolean;
  onSchedule?: () => void;
  onOpen: (kind: WorkbenchModule) => void;
  onToggle: () => void;
  entryRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <div className={css.entries} aria-label="工作台入口">
      {(
        [
          'files',
          ...(props.experience ? ['experience'] : []),
          ...(props.workflow ? ['workflow'] : []),
        ] as WorkbenchModule[]
      ).map((kind) => (
        <button
          type="button"
          key={kind}
          className={`${css.entry} ${css[kind]}`}
          aria-pressed={props.open && props.selected === kind}
          title={moduleLabels[kind]}
          aria-label={`${moduleLabels[kind]}${props.counts[kind] ? `，${props.counts[kind]} 项新增` : ''}`}
          onClick={() => props.onOpen(kind)}
        >
          <WorkbenchIcon kind={kind} />
          {props.counts[kind] > 0 && (
            <span className={css.badge} aria-hidden="true">
              {props.counts[kind] > 99 ? '99+' : props.counts[kind]}
            </span>
          )}
        </button>
      ))}
      {props.schedule && (
        <button
          type="button"
          className={`${css.entry} ${css.schedule}`}
          aria-label="当前会话的定时任务"
          title="当前会话的定时任务"
          aria-pressed={props.open && props.selected === 'schedule'}
          onClick={props.onSchedule}
        >
          <WorkbenchIcon kind="schedule" />
        </button>
      )}
      {!props.open && (
        <button
          type="button"
          className={css.toggle}
          ref={props.entryRef}
          title={props.open ? '收起工作台' : '展开工作台'}
          aria-label={props.open ? '收起工作台' : '展开工作台'}
          aria-expanded={props.open}
          aria-controls="artifact-workbench"
          onClick={props.onToggle}
        >
          <WorkbenchIcon kind="panel" />
        </button>
      )}
    </div>
  );
}
export function WorkbenchStart(props: {
  experience: boolean;
  workflow: boolean;
  onOpen: (kind: WorkbenchModule) => void;
  terminal?: ReactNode;
}) {
  return (
    <div className={css.guide}>
      <span className={css.compass}>
        <WorkbenchIcon kind="start" size={54} />
      </span>
      <div className={css.cards}>
        {(
          [
            'files',
            ...(props.experience ? ['experience'] : []),
            ...(props.workflow ? ['workflow'] : []),
          ] as WorkbenchModule[]
        ).map((kind) => (
          <button
            type="button"
            key={kind}
            className={css.card}
            onClick={() => props.onOpen(kind)}
          >
            <span className={`${css.tile} ${css[kind]}`}>
              <WorkbenchIcon kind={kind} size={27} />
            </span>
            <span>
              <strong>{moduleLabels[kind]}</strong>
              <small>
                {kind === 'files'
                  ? '文件、交付成果与参考资料'
                  : kind === 'experience'
                    ? '查看、使用和纠正工作经验'
                    : '打开这位员工的业务工作台'}
              </small>
            </span>
            <span className={css.chevron} aria-hidden="true">
              <WorkbenchIcon kind="chevron-right" />
            </span>
          </button>
        ))}
        {props.terminal}
      </div>
    </div>
  );
}

/** Metadata refreshes on completed work, focus or a file mutation. No preview
 * requests or polling run just to keep a notification badge up to date. */
export function useWorkbenchDirectory(input: {
  enabled: boolean;
  workspaceId?: string;
  instanceId?: string;
  scope: string;
  headers: Record<string, string>;
  refreshKey: string;
}) {
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    fileIds: string[] | null;
    experienceIds: string[] | null;
  } | null>(null);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((n) => n + 1), []);
  const active = useRef(input.scope);
  active.current = input.scope;
  const headers = useRef(input.headers);
  headers.current = input.headers;
  const lastRead = useRef(0);
  useEffect(() => {
    const focus = () => {
      if (
        document.visibilityState === 'visible' &&
        Date.now() - lastRead.current > 15000
      )
        reload();
    };
    window.addEventListener('focus', focus);
    window.addEventListener('allrice:workbench-files-changed', reload);
    return () => {
      window.removeEventListener('focus', focus);
      window.removeEventListener('allrice:workbench-files-changed', reload);
    };
  }, [reload]);
  useEffect(() => {
    if (!input.enabled || !input.workspaceId) return;
    const controller = new AbortController(),
      scope = input.scope;
    const query = new URLSearchParams({
      workspaceId: input.workspaceId,
      ...(input.instanceId ? { instanceId: input.instanceId } : {}),
    });
    const timer = window.setTimeout(() => {
      lastRead.current = Date.now();
      void workbenchJson(
        '/api/v1/workbench/updates?' + query,
        headers.current,
        { signal: controller.signal },
      )
        .then((value) =>
          z
            .object({
              fileIds: z.array(z.string()).nullable(),
              experienceIds: z.array(z.string()).nullable(),
            })
            .parse(value),
        )
        .then((value) => {
          if (!controller.signal.aborted && active.current === scope)
            setSnapshot({ scope, ...value });
        })
        .catch(() => {
          if (!controller.signal.aborted && active.current === scope)
            setSnapshot({ scope, fileIds: null, experienceIds: null });
        });
    }, 120);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [
    input.enabled,
    input.scope,
    input.workspaceId,
    input.instanceId,
    input.refreshKey,
    revision,
  ]);
  return {
    fileIds: snapshot?.scope === input.scope ? snapshot.fileIds : null,
    experienceIds:
      snapshot?.scope === input.scope ? snapshot.experienceIds : null,
    reload,
  };
}

export function unreadKeys(raw: string | null): Set<string> | null {
  try {
    const value = JSON.parse(raw ?? 'null');
    return Array.isArray(value) &&
      value.length <= 2000 &&
      value.every((item) => typeof item === 'string')
      ? new Set(value)
      : null;
  } catch {
    return null;
  }
}
/** Per viewer/company browser read markers; a failed or denied catalog is never
 * acknowledged as an empty successful read. Other modules keep their counts. */
export function useWorkbenchUnread(
  key: string,
  keys: readonly string[] | null,
) {
  const [seen, setSeen] = useState<{ key: string; ids: Set<string> } | null>(
    null,
  );
  const identity = JSON.stringify(keys),
    latest = useRef(keys);
  latest.current = keys;
  useEffect(() => {
    const storageKey = 'allrice:workbench-read:v1:' + key;
    let stored: Set<string> | null = null;
    try {
      stored = unreadKeys(localStorage.getItem(storageKey));
    } catch {
      /* Session memory works in private mode. */
    }
    if (stored) {
      setSeen({ key, ids: stored });
      return;
    }
    if (latest.current) {
      const ids = new Set(latest.current);
      setSeen({ key, ids });
      try {
        localStorage.setItem(storageKey, JSON.stringify([...ids]));
      } catch {
        /* Nonpersistent read state remains usable. */
      }
    } else setSeen(null);
  }, [key, keys === null]);
  const markRead = useCallback(() => {
    if (!latest.current) return;
    const ids = new Set(latest.current);
    setSeen({ key, ids });
    try {
      localStorage.setItem(
        'allrice:workbench-read:v1:' + key,
        JSON.stringify([...ids].slice(-2000)),
      );
    } catch {
      /* Keep in-memory state. */
    }
  }, [key]);
  const current = seen?.key === key ? seen.ids : null;
  return {
    count: keys && current ? keys.filter((id) => !current.has(id)).length : 0,
    markRead,
    identity,
  };
}
