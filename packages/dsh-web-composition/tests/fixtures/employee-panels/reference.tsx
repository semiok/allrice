import type { Context } from '@deepseek-ai/cordis';
import { useMemo, useSyncExternalStore } from 'react';
import type {
  PropsRuntime,
  SessionIdOf,
} from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type {} from '@deepseek-ai/dsh-client-ui-theme/client';
import { EnterpriseMaterialsPanel } from '../../../../../apps/web/app/chatflow/enterprise-materials-panel';
import { WorkbenchFilesPanel } from '../../../../../apps/web/app/chatflow/workbench-files-panel';
import { EmployeeMemorySidebar } from '../../../../../apps/web/app/chatflow/employee-memory-sidebar';
import { EmployeeCapabilitiesPanel } from '../../../../../apps/web/app/chatflow/employee-capabilities-panel';
import { syntheticPanelSnapshot } from './presentation';
import { panelStates, type PanelsState } from './data';

export const referenceCarrierId = 'pinned-rev2-public-slot-v1';
export const referenceKinds = [
  'files',
  'materials',
  'experience',
  'workflow',
] as const;
export type ReferenceKind = (typeof referenceKinds)[number];
const titles = {
  files: '交付成果',
  materials: '企业资料',
  experience: '记忆',
  workflow: '能力',
};
const sessionId = 'session-00000000-0000-4000-8000-000000000036' as SessionIdOf;

/** The builder reads every app/UI/contracts import at fixed rev2, not current
 * product. These are the original replay's props and inert business callbacks. */
export function renderReferenceContent(
  kind: ReferenceKind,
  state: PanelsState,
  active: boolean,
) {
  const scope = syntheticPanelSnapshot(
    'synthetic/rev2-visual-replay',
    state,
    () => {},
  );
  switch (kind) {
    case 'materials':
      return (
        <EnterpriseMaterialsPanel
          {...scope.materials}
          active={active}
          onUse={() => {}}
        />
      );
    case 'files':
      return (
        <WorkbenchFilesPanel
          {...scope.files}
          active={active}
          onUse={() => {}}
        />
      );
    case 'experience':
      return <EmployeeMemorySidebar {...scope.experience} active={active} />;
    case 'workflow':
      return (
        <EmployeeCapabilitiesPanel
          {...scope.workflow({
            signal: new AbortController().signal,
            openMain: async () => {},
          })}
          active={active}
        />
      );
  }
}

/** Unboxed equivalents of the pinned document root/body. They own the old
 * tokens and theme selectors; the public native pane owns all geometry. */
export function renderReferenceSurface(
  content: React.ReactNode,
  theme: 'light' | 'dark',
  width: number,
  height: number,
) {
  return (
    <div
      data-panels-reference-document={referenceCarrierId}
      data-theme={theme}
      data-allrice-framework="v2"
    >
      <div
        data-panels-reference-body=""
        data-ds-dark-theme={theme === 'dark' ? '' : undefined}
      >
        <div
          data-panels-reference-carrier={referenceCarrierId}
          className="m0-before"
          style={{ width, height }}
        >
          {content}
        </div>
      </div>
    </div>
  );
}

/** Callable test contribution: the real Host owns React, tab/session scope and
 * unmount. There is no independent createRoot, product binder or business owner. */
export function createReferenceFixture() {
  return {
    inject: [
      'slots',
      'sidebarRightTabs',
      'sidebarRight',
      'sessions',
      'workspaces',
      'uiWorkspace',
      'theme',
    ],
    apply(ctx: Context) {
      installReference(ctx);
    },
  };
}

function installReference(ctx: Context) {
  const query = new URLSearchParams(location.search);
  const kind = referenceKinds.find((value) => value === query.get('kind'));
  const state = panelStates.find((value) => value === query.get('state'));
  const theme = query.get('theme');
  const width = Number(query.get('paneWidth')),
    height = Number(query.get('paneHeight'));
  if (
    !kind ||
    !state ||
    !['light', 'dark'].includes(theme ?? '') ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    throw Error('Invalid pinned reference carrier options');
  ctx.theme.setTheme(theme as 'light' | 'dark');
  // A fresh carrier can observe the session's previous native tab before the
  // explicit replay inventory is selected. Do not start its business effects
  // during that preparation; native tab/session state is still authoritative.
  let renderEnabled = false;
  const renderListeners = new Set<() => void>();
  const subscribeRender = (listener: () => void) => {
    renderListeners.add(listener);
    return () => {
      renderListeners.delete(listener);
    };
  };
  const rendering = () => renderEnabled;
  for (const key of referenceKinds) {
    const id = `allrice-employee-panels.${key}`;
    ctx.effect(() =>
      ctx.sidebarRightTabs.register({
        id,
        kind: id,
        title: () => titles[key],
      }),
    );
    ctx.slots.inject('sidebar.right.pane.tab', () =>
      ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key: id },
        (props: PropsRuntime<'sidebar.right.pane.tab'>) => {
          const { tab } = props.useTabInfo();
          const enabled = useSyncExternalStore(
            subscribeRender,
            rendering,
            rendering,
          );
          const active = tab.visible && !tab.signal.aborted;
          const content = useMemo(
            () => renderReferenceContent(key, state, active),
            [key, state, active],
          );
          if (!active || !enabled) return null;
          return renderReferenceSurface(
            content,
            theme as 'light' | 'dark',
            width,
            height,
          );
        },
      ),
    );
  }
  let ready = false,
    stopped = false;
  const test = {
    evidence: () => ({
      carrier: referenceCarrierId,
      kind,
      state,
      theme,
      width,
      height,
      sessionId: ctx.sidebarRight.mounted.getSnapshot() ?? null,
      retainedReady: ready,
      renderEnabled,
      activeKind: ctx.sidebarRight.active()?.kind ?? null,
      expanded: ctx.sidebarRight.isExpanded(),
      panelEntries: ctx.slots
        .entries('sidebar.right.pane.tab')
        .map((entry) => entry.options.key),
      businessOwner:
        'visual reference only; no authenticated BFF/MCP or product owner',
    }),
    open(opened: ReferenceKind[]) {
      if (
        !ready ||
        ctx.sidebarRight.mounted.getSnapshot() !== sessionId ||
        !opened.includes(kind) ||
        new Set(opened).size !== opened.length ||
        opened.some((key) => !referenceKinds.includes(key))
      )
        throw Error('Reference native session/tab inventory is not ready');
      for (const key of opened)
        ctx.sidebarRight.openTab(`allrice-employee-panels.${key}`);
      // This list preserves native tab creation order across the state's
      // replay. Reopening an existing public page selects it without changing
      // that inventory; its final item need not be the requested active kind.
      if (opened.at(-1) !== kind)
        ctx.sidebarRight.openTab(`allrice-employee-panels.${kind}`);
      renderEnabled = true;
      for (const listener of renderListeners) listener();
    },
  };
  ctx.effect(() => {
    let reference: ReturnType<Context['sessions']['retain']> | undefined;
    let started = false;
    const failed = (error: unknown) => {
      console.error('Pinned reference native session failed', error);
    };
    const open = () => {
      if (
        stopped ||
        started ||
        ctx.sessions.list.getSnapshot().phase !== 'ready' ||
        ctx.workspaces.list.getSnapshot().phase !== 'ready'
      )
        return;
      // retain publishes to the same list synchronously before it returns.
      // Claim this one startup attempt first; failures remain visible, without
      // subscription-driven retries. A fresh fixture owns a fresh attempt.
      started = true;
      try {
        reference = ctx.sessions.retain(sessionId, {
          source: 'workspaceOperation',
        });
        void reference.ready.then(() => {
          if (stopped) return;
          ready = true;
          ctx.uiWorkspace.openSession(sessionId);
        }, failed);
      } catch (error) {
        // Keep cleanup registered even for an immediate public retain refusal.
        failed(error);
      }
    };
    window.__allricePanelsReference = test;
    const stopSessions = ctx.sessions.list.subscribe(open),
      stopWorkspaces = ctx.workspaces.list.subscribe(open);
    open();
    return () => {
      stopped = true;
      ready = false;
      renderEnabled = false;
      renderListeners.clear();
      stopSessions();
      stopWorkspaces();
      reference?.release();
      if (window.__allricePanelsReference === test)
        delete window.__allricePanelsReference;
    };
  });
  return test;
}

export type PanelsReferenceIntegration = ReturnType<typeof installReference>;
declare global {
  interface Window {
    __allricePanelsReference?: PanelsReferenceIntegration;
  }
}
