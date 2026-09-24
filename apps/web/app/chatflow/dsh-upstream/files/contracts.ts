// Type-only Allrice host seams. Native tree, state and request lifetimes remain upstream.
import type { BoundActions } from '@deepseek-ai/dsh-client-store';
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit';
import type { createFilesStore, FilesState } from './store';
import type { SidebarFilesKey } from './locales';
export type SessionId = string;
export type RemoteFailure = {code: string; message: string};
export type RemoteResult<T> = {ok: true; value: T} | {ok: false; error: RemoteFailure};
export type WorkspaceDirectoryEntry = {name: string; displayName?: string; type: 'file' | 'directory' | 'other'};
export type TranslateNS<_Name extends string> = (key: _Name extends 'sidebarFiles' ? SidebarFilesKey : never, params?: Record<string, string | number>) => string;
export interface FilesBodyHostProps {
  sessionId: string;
  useTabInfo: () => {tab: {id: TabId; signal: AbortSignal; actions: {openResource: (address: string) => void}}};
  useSessions: <T>(select: (state: {byId: Record<string, {cwd?: string}>}) => T) => T;
  useStore: <T>(select: (state: FilesState) => T) => T;
  actions: BoundActions<ReturnType<typeof createFilesStore>>;
  t: TranslateNS<'sidebarFiles'>;
}
