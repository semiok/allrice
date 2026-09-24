// Type-only host projection for the pinned DSH workspace components. Allrice
// assignment IDs are display groups here, never replacement tenant workspace IDs.
import type { ReactNode, Dispatch, SetStateAction } from 'react';
import type { WorkspaceKey } from './locales';

export type SessionId = string;
export type WorkspaceId = string;
export interface WorkspaceView {
  workspaceId: string;
  title: string;
  path: string;
  createdAt: string;
  sessionIds: string[];
}
export interface SessionSummary {
  id: string;
  displayTitle: string;
  cwd?: string;
  origin?: string;
  parentId?: string;
  blank: boolean;
  running: boolean;
  updatedAt: number;
  retainedBy: { mainView?: number };
  projectionValues?: { schedule?: unknown[] };
}
export interface SessionListState {
  ids: string[];
  byId: Record<string, SessionSummary>;
  projectionsBySession: Record<
    string,
    { values: { subagentCatalog?: { id: string }[] } }
  >;
}
export type SessionStatusSnapshot = ReadonlyMap<
  string,
  {
    running: boolean;
    completionUnread?: boolean;
    pendingInteraction?: { kind: string };
  }
>;
export interface SessionSearchResultItem {
  sessionId: string;
  snippet: string;
}
export interface WorkspaceBrowserProps {
  t: (
    key: WorkspaceKey | 'copy',
    params?: Record<string, string | number>,
  ) => string;
}
export type MenuOpenState = readonly [
  boolean,
  Dispatch<SetStateAction<boolean>>,
];
export type PropsRenderSlots<Name extends string> = {
  renderSlot: (
    name: Name,
    props: { sessionId: string; displayTitle: string },
    context?: { hookContext: MenuOpenState },
  ) => ReactNode;
};
