/* global window, localStorage */
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
    } = require('@allrice/dsh-web-composition');
    const first = 'session-00000000-0000-4000-8000-000000000036';
    const second = 'session-00000000-0000-4000-8000-000000000031';
    const fixtureEmployee = window.__allriceFixtureEmployee ?? 'rice';
    const fixedNow = Date.parse('2026-11-21T12:00:00.000Z');
    const employee = (id, name) => ({
      id,
      employeeId: id,
      isDefault: id === 'rice',
      versions: [],
      currentVersion: {
        id: `${id}-v1`,
        manifest: { name, description: '合成员工：验证现有左栏组件。' },
      },
    });
    const employees = [
      employee('rice', 'Rice'),
      employee('writer', '文案助理与季度报告编辑员'),
      employee('empty', '空员工'),
    ];
    const sessions = Array.from({ length: 39 }, (_, index) => ({
      id: `thread-${index}`,
      title:
        index === 0
          ? '核对季度销售预算与重点客户跟进计划：覆盖全部区域、长标题和待办事项'
          : index === 1
            ? 'QuarterlyRevenueCustomerFollowUpReport_2026_AllRegions_FinalReview_NoSpaces'
            : `工作 ${index + 1} · 合成历史记录`,
      ownerId: 'person',
      employeeAssignmentId: index < 32 ? 'rice' : 'writer',
      employeeVersionId: index < 32 ? 'rice-v1' : 'writer-v1',
      visibility: 'private',
      updatedAt: new Date(fixedNow - index * 60000).toISOString(),
      archivedAt:
        index === 31 ? new Date(fixedNow - 86400000).toISOString() : null,
    }));
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
        const listeners = new Set();
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
          openEmployeeSettings: () => record('employee-settings'),
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
