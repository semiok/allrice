import { vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { SessionIdOf } from '@deepseek-ai/dsh-client-ui-slots';
import type {
  EmployeePanelsBinding,
  EmployeePanelsPort,
  EmployeePanelsSnapshot,
} from '../../../src/employee-panels-port';

/** Synthetic UI controller only: no authenticated BFF, business writes or
 * production transport. Successful callback calls are not business receipts. */
export function syntheticPanelsOwner() {
  const sessionId = 'synthetic-native-session' as SessionIdOf;
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  const onOpen = vi.fn();
  const onConfirm = vi.fn(async () => {});
  let snapshot: EmployeePanelsSnapshot | null = {
    scopeKey: 'synthetic/person/employee/revision-1',
    filesUnread: 2,
    materials: {
      ownerKey: 'synthetic',
      viewerId: '00000000-0000-4000-8000-000000000001',
      workspaceId: '00000000-0000-4000-8000-000000000002',
      sessionId: '00000000-0000-4000-8000-000000000003',
      headers: {},
    },
    files: {
      ownerKey: 'synthetic',
      viewerId: '00000000-0000-4000-8000-000000000001',
      workspaceId: '00000000-0000-4000-8000-000000000002',
      sessionId: '00000000-0000-4000-8000-000000000003',
      headers: {},
      refreshKey: 'synthetic',
      onOpen,
    },
    experience: {
      targetKey: 'synthetic',
      employeeName: 'Rice',
      rows: [],
      onReload: vi.fn(),
      onReadDetail: vi.fn(async () => {
        throw new Error('No synthetic detail');
      }),
      onConfirm,
      onDelete: vi.fn(async () => {}),
      onSave: vi.fn(async () => {}),
    },
    workflow: () => ({
      employeeName: 'Rice',
      scopeKey: 'synthetic',
      onRead: vi.fn(),
      showSkills: false,
      children: null,
    }),
  };
  const port: EmployeePanelsPort = {
    getSnapshot: (id) => (id === sessionId ? snapshot : null),
    subscribe: (id, listener) => {
      if (id !== sessionId) throw Error('Synthetic target mismatch');
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    useReference: vi.fn(() => true),
  };
  const binding: EmployeePanelsBinding = { port, signal: lifetime.signal };
  return {
    sessionId,
    lifetime,
    port,
    binding,
    listeners,
    onOpen,
    onConfirm,
    snapshot: () => snapshot!,
    publish(value: EmployeePanelsSnapshot | null) {
      snapshot = value;
      for (const listener of listeners) listener();
    },
  };
}

/** Narrow public navigation/registry faces; never a native Host fixture. */
export function syntheticNavigation(ctx: Context) {
  let mounted = 'synthetic-native-session' as SessionIdOf | undefined;
  const definitions = new Map<
    string,
    Parameters<Context['sidebarRightTabs']['register']>[0]
  >();
  const tabs: Pick<Context['sidebarRightTabs'], 'register'> = {
    register(definition) {
      definitions.set(definition.id, definition);
      return () => {
        definitions.delete(definition.id);
      };
    },
  };
  const right: Pick<
    Context['sidebarRight'],
    'mounted' | 'isExpanded' | 'toggleExpanded' | 'openTab'
  > = {
    mounted: { getSnapshot: () => mounted, subscribe: () => () => {} },
    isExpanded: () => false,
    toggleExpanded: vi.fn(),
    openTab: vi.fn(),
  };
  const layout = { selectPanel: vi.fn() };
  ctx.provide('sidebarRightTabs', tabs as Context['sidebarRightTabs']);
  ctx.provide('sidebarRight', right as Context['sidebarRight']);
  ctx.provide('layout', layout as unknown as Context['layout']);
  return {
    definitions,
    right,
    layout,
    selectSession(id: SessionIdOf | undefined) {
      mounted = id;
    },
  };
}
