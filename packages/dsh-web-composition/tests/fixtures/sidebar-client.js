/* global window, localStorage, ReadableStream */
// Synthetic business port only. Product code has no fallback/fixture port.
window.__ModuleLoader__.load({
  id: '@allrice/composition-test-fixture',
  factory: (require) => {
    const React = require('react');
    const {
      ChatSidebarFrame,
      EmployeeSidebarView,
      SidebarSettingsTrigger,
      bindEmployeeSidebar,
      bindEmployeeSettings,
      EmployeeClientNavigation,
    } = require('@allrice/dsh-web-composition');
    const { Context } = require('@deepseek-ai/cordis');
    const first = 'session-00000000-0000-4000-8000-000000000036';
    const second = 'session-00000000-0000-4000-8000-000000000031';
    const fixtureEmployee = window.__allriceFixtureEmployee ?? 'rice';
    const { employees, sessions } = window.__allriceSidebarFixtureData;
    return {
      inject: [
        'sessions',
        'workspaces',
        'uiWorkspace',
        'theme',
        'slots',
        'layout',
        'conversation',
      ],
      apply(ctx) {
        const listeners = new Set(),
          settingsListeners = new Set();
        const commands = [];
        const workspace = {
          viewerId: 'person',
          organizationId: 'org',
          workspaceId: 'workspace',
          employees,
          employeeProfiles: [],
          sessions,
          sessionModels: [],
          canAdminister: false,
        };
        const expansionKey = 'allrice.employee-tree.v1:org:workspace:person';
        localStorage.setItem(
          expansionKey,
          JSON.stringify({ rice: true, writer: true, empty: true }),
        );
        let current,
          nativeLauncher,
          baseline = false,
          baselineWidth = 280;
        const publish = (change = {}) => {
          current = {
            ...current,
            ...change,
            tree: { ...current.tree, ...(change.tree ?? {}) },
          };
          for (const listener of listeners) listener();
        };
        const record = (name, id) => {
          commands.push({ name, id });
        };
        const setFilter = (filter) => {
          record('archive-filter', filter);
          const archive = { ...current.archive, filter };
          publish({ archive, tree: { archive } });
        };
        const archive = {
          sessions,
          filter: 'default',
          loading: false,
          error: '',
          loadError: '',
          legacyOverlayOpen: false,
          setFilter,
          reload: () => {
            record('reload');
          },
          hasMore: () => false,
          loadPreview: (id) => record('preview', id),
          loadMore: (id) => record('more', id),
        };
        let controlled;
        current = {
          archive,
          settingsOpen: false,
          tree: {
            workspace,
            sessions,
            activeId: fixtureEmployee === 'rice' ? 'thread-0' : 'thread-32',
            archive,
            nativeReads: {},
            onPrepareSession: (id) => record('prepare', id),
            onSelectSession: (id) => {
              record('select-thread', id);
              const row = sessions.find((session) => session.id === id);
              if (controlled.enabled) {
                controlled.select(row);
                return;
              }
              if (row.employeeAssignmentId !== fixtureEmployee) {
                publish({
                  error: '合成夹具未绑定该员工客户端',
                  tree: { activeId: null },
                });
                return;
              }
              publish({ error: undefined, tree: { activeId: id } });
              ctx.uiWorkspace.openSession(id === 'thread-0' ? first : second);
            },
            onEmployeeNavigate: (id) => record('select-employee', id),
            onNewSession: (id) => record('new-thread', id),
            onDetails: (id) => record('details', id),
          },
        };
        // A real Cordis root + native retained references exercise the opaque
        // ownership port. No Web Client/HTTP/WS mount is available here; this
        // controlled mode deliberately never calls uiWorkspace.openSession.
        const ownerEvents = [];
        const lateCallbacks = new Map();
        let navigation,
          viewRequest = 0,
          revision = 1,
          rootNumber = 0,
          holdCreation = false,
          releaseCreation,
          creating = null,
          denyNext = false;
        controlled = {
          enabled: false,
          events: ownerEvents,
          start() {
            if (controlled.enabled)
              throw new Error('Controlled owner already active');
            controlled.enabled = true;
            navigation = new EmployeeClientNavigation({
              async admit(input, signal) {
                ownerEvents.push({
                  event: 'admit',
                  employee: input.employeeInstanceId,
                });
                if (signal.aborted) throw new Error('superseded');
                if (denyNext) {
                  denyNext = false;
                  throw new Error(
                    'DEPENDENCY_UNAVAILABLE: controlled admission denied',
                  );
                }
                return {
                  mount: {
                    employee: input.employeeInstanceId,
                    remountKey: `controlled:${input.employeeInstanceId}/${revision}`,
                  },
                  nativeSessionId:
                    input.threadId === 'thread-0' ? first : second,
                };
              },
              async create(mount, lifetime) {
                const id = `${mount.remountKey}#${++rootNumber}`;
                const root = new Context();
                const references = [];
                let live = true;
                const push = (event) => ownerEvents.push({ event, root: id });
                const reader = new ReadableStream({
                  cancel() {
                    push('resource:cancel');
                  },
                }).getReader();
                const pendingRead = reader
                  .read()
                  .then(() => push('resource:settled'));
                const onAbort = () => push('lifetime:abort');
                lifetime.addEventListener('abort', onAbort, { once: true });
                root.effect(() => () => {
                  live = false;
                  lifetime.removeEventListener('abort', onAbort);
                  push('cordis:disposed');
                });
                lateCallbacks.set(id, () => {
                  if (!live || lifetime.aborted) push('late-ui:ignored');
                  else publish({ ownerCurrent: mount.employee });
                });
                push('create:start');
                if (holdCreation) {
                  holdCreation = false;
                  creating = id;
                  await new Promise((done) => {
                    releaseCreation = done;
                  });
                  releaseCreation = undefined;
                  creating = null;
                }
                push('create:return');
                return {
                  async openSession(nativeSessionId, signal) {
                    if (signal.aborted) return;
                    const reference = ctx.sessions.retain(nativeSessionId, {
                      source: 'workspaceOperation',
                    });
                    references.push(reference);
                    await reference.ready;
                    push('native-reference:ready');
                  },
                  async abort() {
                    if (!lifetime.aborted)
                      throw new Error('lifetime must abort first');
                    push('abort:start');
                    await reader.cancel();
                    await pendingRead;
                    push('abort:done');
                  },
                  releaseSessionReferences() {
                    for (const reference of references.splice(0)) {
                      reference.release();
                      push('native-reference:release');
                    }
                    push('references:released');
                  },
                  async destroy() {
                    push('destroy:start');
                    await root.fiber.dispose();
                    push('destroy:done');
                  },
                };
              },
            });
            publish({
              ownerCurrent: '',
              error: undefined,
              tree: { activeId: null },
            });
          },
          select(row) {
            const request = ++viewRequest;
            publish({
              error: undefined,
              tree: { pendingEmployeeAssignmentId: row.employeeAssignmentId },
            });
            navigation
              .select({
                employeeInstanceId: row.employeeAssignmentId,
                threadId: row.id,
              })
              .then(
                (result) => {
                  if (request !== viewRequest || result !== 'opened') return;
                  ownerEvents.push({
                    event: 'ui:opened',
                    employee: row.employeeAssignmentId,
                  });
                  publish({
                    ownerCurrent: row.employeeAssignmentId,
                    tree: {
                      activeId: row.id,
                      pendingEmployeeAssignmentId: null,
                    },
                  });
                },
                (error) => {
                  if (request !== viewRequest) return;
                  publish({
                    ownerCurrent: '',
                    error: error.message,
                    tree: { activeId: null, pendingEmployeeAssignmentId: null },
                  });
                },
              );
          },
          holdNextCreation() {
            holdCreation = true;
          },
          pendingCreation: () => creating,
          releaseCreation: () => releaseCreation?.(),
          changeRevision() {
            revision++;
          },
          denyNext() {
            denyNext = true;
          },
          deliverLate(id) {
            lateCallbacks.get(id)?.();
          },
          async stop() {
            if (!controlled.enabled) return;
            controlled.enabled = false;
            viewRequest++;
            releaseCreation?.();
            await navigation.dispose();
            lateCallbacks.clear();
            publish({
              ownerCurrent: undefined,
              error: undefined,
              tree: {
                activeId: fixtureEmployee === 'rice' ? 'thread-0' : 'thread-32',
                pendingEmployeeAssignmentId: null,
              },
            });
          },
        };
        ctx.effect(() => () => controlled.stop());
        const OwnerStatus = () => {
          const value = React.useSyncExternalStore(
            (listener) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            () => current,
          );
          return value.ownerCurrent === undefined
            ? null
            : React.createElement(
                'output',
                {
                  'aria-label': '受控员工导航',
                  'data-owner-current': value.ownerCurrent,
                  style: {
                    position: 'fixed',
                    right: 8,
                    bottom: 8,
                    pointerEvents: 'none',
                  },
                },
                `受控 owner（非原生 Client 重挂）: ${value.ownerCurrent || '等待选择'}`,
              );
        };
        ctx.slots.register(
          { name: 'shell.overlay', id: 'controlled-owner-status' },
          OwnerStatus,
        );
        bindEmployeeSidebar(ctx, {
          getSnapshot: () => current,
          subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          createEmployee: () => record('create-employee'),
          openArchive: () => {
            record('open-archive');
            setFilter('only');
          },
          openEmployeeSettings: () => nativeLauncher?.openSettings(),
        });
        // This test owner binds the actual settings contribution. Native
        // General remains authoritative for the modal and its open state.
        let settings = {
          scopeKey: `synthetic-sidebar/${fixtureEmployee}`,
          preferences: {
            values: { streamingOutput: true },
            pending: false,
            error: null,
          },
        };
        bindEmployeeSettings(ctx, {
          getSnapshot: () => settings,
          subscribe: (listener) => {
            settingsListeners.add(listener);
            return () => settingsListeners.delete(listener);
          },
          renderSection: (section) =>
            React.createElement(
              'p',
              null,
              `侧栏测试的合成 ${section} owner，不代表真实业务迁移。`,
            ),
          openAccountSettings: () => record('account-settings'),
          reloadPreferences: () => {},
          setStreamingOutput(scope, enabled) {
            if (scope.signal.aborted || scope.key !== settings.scopeKey) return;
            settings = {
              ...settings,
              preferences: {
                values: { streamingOutput: enabled },
                pending: false,
                error: null,
              },
            };
            for (const listener of settingsListeners) listener();
          },
          bindNativeLauncher(value) {
            nativeLauncher = value;
            if (current.settingsOpen !== value.settingsOpen)
              publish({ settingsOpen: value.settingsOpen });
            return () => {
              if (nativeLauncher === value) nativeLauncher = undefined;
            };
          },
        });
        const Baseline = () => {
          const value = React.useSyncExternalStore(
            (listener) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            () => current,
          );
          return React.createElement(
            'div',
            {
              'data-sidebar-baseline': true,
              style: {
                position: 'fixed',
                inset: '0 auto 0 0',
                width: baselineWidth,
                height: '100vh',
                pointerEvents: 'auto',
              },
            },
            React.createElement(ChatSidebarFrame, {
              archive: value.archive,
              collapsed: false,
              style: { height: '100%' },
              onCollapsedChange: () => record('baseline-collapse'),
              onCreateEmployee: () => record('create-employee'),
              onOpenArchive: () => setFilter('only'),
              onOpenAutomations: () => ctx.layout.selectPanel('schedules'),
              employeeTree: React.createElement(EmployeeSidebarView, {
                ...value.tree,
                collapsed: false,
              }),
              settings: React.createElement(SidebarSettingsTrigger, {
                collapsed: false,
                expanded: false,
                onOpen: () => record('employee-settings'),
              }),
            }),
          );
        };
        let removeBaseline;
        const test = {
          fixtureEmployee,
          commands,
          settingsLauncher: () => ({
            ready: !!nativeLauncher,
            open: current.settingsOpen,
          }),
          controlledOwner: controlled,
          openSession: (id) => ctx.uiWorkspace.openSession(id),
          setTheme: (mode) => ctx.theme.setTheme(mode),
          setState: (kind) => {
            const archive = {
              ...current.archive,
              loading: kind === 'loading',
              loadError:
                kind === 'error' || kind === 'loading'
                  ? '合成列表读取失败'
                  : '',
            };
            publish({
              archive,
              tree: { archive, sessions: kind === 'empty' ? [] : sessions },
              error: kind === 'denied' ? '当前员工暂不可用' : undefined,
            });
          },
          baseline: (visible, width = 280) => {
            if (baseline === visible) return;
            baseline = visible;
            baselineWidth = width;
            removeBaseline?.();
            removeBaseline = undefined;
            if (visible)
              removeBaseline = ctx.slots.register(
                { name: 'shell.overlay', id: 'allrice-sidebar-baseline' },
                Baseline,
              );
          },
          async nativeInput(id = first) {
            const reference = ctx.sessions.retain(id, {
              source: 'workspaceOperation',
            });
            try {
              const binding = await reference.ready;
              const input = ctx.conversation.input
                .for(binding.ctx)
                .state.getSnapshot();
              return {
                draft: input.draft,
                attachmentCount: input.attachmentIds.length,
              };
            } finally {
              reference.release();
            }
          },
          async nativeScroll(id = first) {
            const reference = ctx.sessions.retain(id, {
              source: 'workspaceOperation',
            });
            try {
              await reference.ready;
              const chat = ctx.slots
                .entriesOfSlot('conversation.view')
                .find((entry) => entry.options.id === 'chat');
              return chat.inject(id).chatScroll.read();
            } finally {
              reference.release();
            }
          },
        };
        ctx.effect(() => {
          let opened = false;
          const open = () => {
            if (
              opened ||
              ctx.sessions.list.getSnapshot().phase !== 'ready' ||
              ctx.workspaces.list.getSnapshot().phase !== 'ready'
            )
              return;
            opened = true;
            ctx.uiWorkspace.openSession(first);
            window.__allriceSidebarTest = test;
          };
          const stopSessions = ctx.sessions.list.subscribe(open),
            stopWorkspaces = ctx.workspaces.list.subscribe(open);
          open();
          return () => {
            stopSessions();
            stopWorkspaces();
            removeBaseline?.();
            if (window.__allriceSidebarTest === test)
              delete window.__allriceSidebarTest;
          };
        });
      },
    };
  },
});
