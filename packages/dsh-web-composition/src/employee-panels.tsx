import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {
  PropsRuntime,
  SessionIdOf,
} from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import { EnterpriseMaterialsPanel } from '../../../apps/web/app/chatflow/enterprise-materials-panel';
import { WorkbenchFilesPanel } from '../../../apps/web/app/chatflow/workbench-files-panel';
import { EmployeeMemorySidebar } from '../../../apps/web/app/chatflow/employee-memory-sidebar';
import { EmployeeCapabilitiesPanel } from '../../../apps/web/app/chatflow/employee-capabilities-panel';
import {
  WorkbenchEntries,
  moduleLabels,
} from '../../../apps/web/app/chatflow/workbench-modules';
import {
  assertEmployeePanelsCurrent,
  assertEmployeePanelSession,
  employeePanelKinds,
  employeePanelsActions,
  employeePanelsSnapshot,
  guardEmployeePanelProps,
  subscribeEmployeePanels,
  insertEmployeePanelReference,
  type EmployeePanelKind,
} from './employee-panels-model';
import type {
  EmployeePanelsBinding,
  EmployeePanelsPort,
  EmployeePanelsSnapshot,
} from './employee-panels-port';
import '@allrice/ui/tokens.css';
import css from './employee-panels.module.css';

function useOwner(binding: EmployeePanelsBinding, sessionId: SessionIdOf) {
  const subscribe = useCallback(
    (listener: () => void) =>
      subscribeEmployeePanels(binding, sessionId, listener),
    [binding, sessionId],
  );
  const read = useCallback(
    () => employeePanelsSnapshot(binding, sessionId),
    [binding, sessionId],
  );
  return useSyncExternalStore(subscribe, read, read);
}

/** Exported render seam uses the real components; it is not another panel UI. */
export function EmployeePanelContent({
  ctx,
  binding,
  sessionId,
  snapshot,
  signal,
  kind,
}: {
  ctx: Context;
  binding: EmployeePanelsBinding;
  sessionId: SessionIdOf;
  snapshot: EmployeePanelsSnapshot;
  signal: AbortSignal;
  kind: EmployeePanelKind;
}) {
  const current = () => {
    assertEmployeePanelSession(ctx, sessionId);
    assertEmployeePanelsCurrent(binding, sessionId, snapshot, signal);
  };
  const reference = (
    value: Parameters<typeof insertEmployeePanelReference>[4],
  ) => {
    current();
    insertEmployeePanelReference(binding, sessionId, snapshot, signal, value);
  };
  switch (kind) {
    case 'materials':
      return (
        <EnterpriseMaterialsPanel
          {...guardEmployeePanelProps(snapshot.materials, current)}
          active
          readOnly={snapshot.materials.readOnly || !binding.port.useReference}
          onUse={reference}
        />
      );
    case 'files':
      return (
        <WorkbenchFilesPanel
          {...guardEmployeePanelProps(snapshot.files, current)}
          active
          readOnly={snapshot.files.readOnly || !binding.port.useReference}
          onUse={reference}
        />
      );
    case 'experience':
      return (
        <EmployeeMemorySidebar
          {...guardEmployeePanelProps(snapshot.experience, current)}
          active
        />
      );
    case 'workflow':
      return (
        <EmployeeCapabilitiesPanel
          {...guardEmployeePanelProps(
            snapshot.workflow(
              employeePanelsActions(ctx, binding, sessionId, snapshot, signal),
            ),
            current,
          )}
          active
        />
      );
  }
}

export function EmployeePanelBody({
  ctx,
  binding,
  kind,
  sessionId,
  useTabInfo,
}: PropsRuntime<'sidebar.right.pane.tab'> & {
  ctx: Context;
  binding: EmployeePanelsBinding;
  kind: EmployeePanelKind;
}) {
  const snapshot = useOwner(binding, sessionId);
  const { tab } = useTabInfo();
  const lifetime = useMemo(
    () => new AbortController(),
    [sessionId, snapshot?.scopeKey, tab.signal, tab.visible],
  );
  useEffect(() => () => lifetime.abort(), [lifetime]);
  const signal = useMemo(
    () => AbortSignal.any([binding.signal, tab.signal, lifetime.signal]),
    [binding.signal, tab.signal, lifetime],
  );
  if (!snapshot || !tab.visible || signal.aborted) return null;
  return (
    <div className={`${css.surface} ${css.body}`} key={snapshot.scopeKey}>
      <EmployeePanelContent
        ctx={ctx}
        binding={binding}
        sessionId={sessionId}
        snapshot={snapshot}
        signal={signal}
        kind={kind}
      />
    </div>
  );
}

export function EmployeePanelsHeader({
  ctx,
  binding,
  sessionId,
}: PropsRuntime<'conversation.session.header.actions'> & {
  ctx: Context;
  binding: EmployeePanelsBinding;
}) {
  const snapshot = useOwner(binding, sessionId);
  return snapshot && snapshot.filesUnread !== null ? (
    <div className={`${css.surface} ${css.header}`}>
      <EmployeePanelsEntries
        ctx={ctx}
        binding={binding}
        sessionId={sessionId}
        snapshot={snapshot}
      />
    </div>
  ) : null;
}

/** Four launchers reuse the approved view; native panes own selection state. */
export function EmployeePanelsEntries({
  ctx,
  binding,
  sessionId,
  snapshot,
}: {
  ctx: Context;
  binding: EmployeePanelsBinding;
  sessionId: SessionIdOf;
  snapshot: EmployeePanelsSnapshot;
}) {
  if (!snapshot || snapshot.filesUnread === null) return null;
  return (
    <WorkbenchEntries
      counts={{
        files: snapshot.filesUnread,
        materials: 0,
        experience: 0,
        workflow: 0,
      }}
      experience
      workflow
      open={ctx.sidebarRight.isExpanded()}
      showToggle={false}
      onToggle={() => ctx.sidebarRight.toggleExpanded()}
      onOpen={(kind) => {
        assertEmployeePanelSession(ctx, sessionId);
        assertEmployeePanelsCurrent(binding, sessionId, snapshot);
        ctx.sidebarRight.openTab(employeePanelKinds[kind]);
      }}
    />
  );
}

/** Only public registries; no default owner, private component or Dock store. */
export function apply(ctx: Context) {
  ctx.inject(
    ['allriceEmployeePanels', 'sidebarRightTabs', 'sidebarRight', 'layout'],
    (scope) => {
      const binding = scope.allriceEmployeePanels;
      for (const kind of Object.keys(
        employeePanelKinds,
      ) as EmployeePanelKind[]) {
        const id = employeePanelKinds[kind];
        scope.effect(() =>
          scope.sidebarRightTabs.register({
            id,
            kind: id,
            title: () => moduleLabels[kind],
          }),
        );
        scope.slots.inject('sidebar.right.pane.tab', () =>
          scope.slots.register(
            { name: 'sidebar.right.pane.tab', key: id },
            (props: PropsRuntime<'sidebar.right.pane.tab'>) => (
              <EmployeePanelBody
                {...props}
                ctx={scope}
                binding={binding}
                kind={kind}
              />
            ),
          ),
        );
      }
      scope.slots.inject('conversation.session.header.actions', () =>
        scope.slots.register(
          {
            name: 'conversation.session.header.actions',
            id: 'allrice-employee-panels.header',
          },
          (props: PropsRuntime<'conversation.session.header.actions'>) => (
            <EmployeePanelsHeader {...props} ctx={scope} binding={binding} />
          ),
        ),
      );
    },
  );
}

/** Authenticated owner installs this child in its own Cordis lifetime.
 * Disposing the returned fork removes the service and aborts detached intents. */
export function bindEmployeePanels(ctx: Context, port: EmployeePanelsPort) {
  return ctx.plugin({
    apply(owner: Context) {
      const lifetime = new AbortController();
      owner.provide('allriceEmployeePanels', { port, signal: lifetime.signal });
      owner.effect(() => () => lifetime.abort());
    },
  });
}

export type {
  EmployeePanelsActions,
  EmployeePanelsBinding,
  EmployeePanelsPort,
  EmployeePanelsReference,
  EmployeePanelsSnapshot,
} from './employee-panels-port';
