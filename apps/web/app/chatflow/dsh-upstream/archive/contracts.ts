// Allrice's injected data source for the unchanged native archive components.
import type {
  MenuOpenState,
  WorkspaceBrowserProps,
} from '../workspace/contracts';
type Select<T> = <R>(selector: (value: T) => R) => R;
type Locale = { t: WorkspaceBrowserProps['t'] };
export type SessionActivity = {
  kind: string;
  items?: Array<{ id: string; label?: string }>;
};
export interface ArchiveSessionInjected {
  useArchived: Select<ReadonlySet<string>>;
  archiveSession: (sessionId: string) => void;
  unarchiveSession: (sessionId: string) => void;
}
export type SessionRowActionProps<T> = T & Locale & { sessionId: string };
export type SessionMenuItemProps<T> = SessionRowActionProps<T> & {
  useMenuOpenState: () => MenuOpenState;
};
export type SessionArchiveConfirmRequest = {
  sessionId: string;
  displayTitle: string;
  activity: readonly SessionActivity[];
};
export interface SessionArchiveConfirmInjected {
  stopAndArchiveSession: (sessionId: string) => Promise<void>;
}
export type SessionArchiveConfirmProps = Locale &
  SessionArchiveConfirmInjected & {
    useArchiveRequest: Select<SessionArchiveConfirmRequest | null>;
    settleSessionArchive: () => void;
  };
export type RowToastState = (
  | { kind: 'archived'; sessionId: string }
  | { kind: 'stoppedAndArchived'; sessionId: string }
  | { kind: 'createFailed'; message: string }
  | { kind: 'pinFailed' }
  | { kind: 'unpinFailed' }
  | { kind: 'archivedNotOpenable' }
  | { kind: 'defaultWorkspaceFailed' }
) & { seq: number };
export type RowToastProps = Locale & {
  useToast: Select<RowToastState | null>;
  dismissToast: () => void;
  undoArchive: (sessionId: string) => void;
  showArchived: () => void;
};
