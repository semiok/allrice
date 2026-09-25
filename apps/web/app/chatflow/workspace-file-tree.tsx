'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path';
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit';
import { FilesBody } from './dsh-upstream/files/FilesBody';
import { createFilesStore } from './dsh-upstream/files/store';
import {
  filesFace,
  type ListWorkspaceDirectory,
  type WatchWorkspaceDirectory,
} from './dsh-upstream/files/face';
import { zh } from './dsh-upstream/files/locales';
import type { WorkspaceFile } from './chatflow-types';
import { readJson } from './chatflow-utils';
import { isToolResultFile } from '../../lib/chatflow/document-reader-model';

// Object-store categories, not a host filesystem path. IDs give duplicate names
// separate identities; displayName keeps the actual filename on the native row.
const root = '/工作区文件';
const categories = {
  上传文件: 'uploads',
  交付文件: 'exports',
  过程资料: 'tool-results',
} as const;
export function WorkspaceFileTree(props: {
  workspaceId: string;
  sessionId: string;
  tabId: TabId;
  tenantHeaders: Record<string, string>;
  onOpen: (file: WorkspaceFile) => void;
}) {
  const createBinding = () => {
    const instance = createFilesStore().create();
    const lifetime = new AbortController();
    const files = new Map<string, WorkspaceFile>();
    const list: ListWorkspaceDirectory = async (_session, path, signal) => {
      if (path === root)
        return {
          ok: true,
          value: {
            entries: Object.keys(categories).map((name) => ({
              name,
              type: 'directory',
            })),
            truncated: false,
          },
        };
      const category =
        categories[path.slice(root.length + 1) as keyof typeof categories];
      if (!category)
        return {
          ok: false,
          error: { code: 'workspace-file/not-found', message: '目录已不存在' },
        };
      try {
        const result = await readJson<{ files: WorkspaceFile[] }>(
          await fetch(
            `/api/v1/files?workspaceId=${encodeURIComponent(props.workspaceId)}`,
            { headers: props.tenantHeaders, signal },
          ),
        );
        if (signal.aborted)
          return {
            ok: false,
            error: { code: 'request/aborted', message: '已取消' },
          };
        const belongs = (file: WorkspaceFile) =>
          category === 'tool-results'
            ? file.category === 'exports' &&
              isToolResultFile(file.fileName, file.id)
            : file.category === category &&
              (category !== 'exports' ||
                !isToolResultFile(file.fileName, file.id));
        for (const [id, file] of files) if (belongs(file)) files.delete(id);
        const matching = result.files.filter(belongs);
        for (const file of matching) files.set(file.id, file);
        return {
          ok: true,
          value: {
            entries: matching.map((file) => ({
              name: file.id,
              displayName:
                category === 'tool-results'
                  ? `${file.fileName.startsWith('tool-result-web-search-') ? '搜索资料' : '工具记录'} · ${file.id.slice(0, 8)}`
                  : file.fileName,
              type: 'file',
            })),
            truncated: result.files.length >= 100,
          },
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'file/unavailable',
            message: error instanceof Error ? error.message : '读取失败',
          },
        };
      }
    };
    // There is no object-store watch endpoint. Native expand/manual refresh work
    // normally; wait for lifetime cancellation instead of adding a polling loop.
    const watch: WatchWorkspaceDirectory = async function* (
      _session,
      _path,
      signal,
    ) {
      if (signal.aborted) return;
      yield 'ready';
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    };
    return {
      instance,
      lifetime,
      files,
      face: filesFace(list, watch)(props.sessionId, instance.actions),
    };
  };
  const [binding, setBinding] = useState(createBinding);
  const state = useSyncExternalStore(
    binding.instance.subscribe,
    binding.instance.getSnapshot,
    binding.instance.getSnapshot,
  );
  useEffect(() => {
    if (binding.lifetime.signal.aborted) setBinding(createBinding());
    return () => binding.lifetime.abort();
  }, [binding]);
  return (
    <FilesBody
      {...binding.face}
      sessionId={props.sessionId}
      useTabInfo={() => ({
        tab: {
          id: props.tabId,
          signal: binding.lifetime.signal,
          actions: {
            openResource(address) {
              const parsed = parseFileAddress(address);
              const file =
                parsed && binding.files.get(parsed.path.split('/').at(-1)!);
              if (file) props.onOpen(file);
            },
          },
        },
      })}
      useSessions={(select) =>
        select({ byId: { [props.sessionId]: { cwd: root } } })
      }
      useStore={(select) => select(state)}
      actions={binding.instance.actions}
      t={(key, params) =>
        Object.entries(params ?? {}).reduce(
          (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
          zh[key] as string,
        )
      }
    />
  );
}
