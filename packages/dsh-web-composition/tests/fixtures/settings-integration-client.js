/* global window, requestAnimationFrame */
// Test-only synthetic business owner. No real identity, API or 3.x migration.
window.__ModuleLoader__.load({
  id: '@allrice/composition-test-fixture',
  factory: (require) => {
    const React = require('react');
    const {
      Modal,
      Button,
      Switch,
    } = require('@deepseek-ai/dsh-client-ui-primitives');
    const product = require('@allrice/dsh-web-composition');
    return {
      inject: [
        'slots',
        'layout',
        'theme',
        'sessions',
        'workspaces',
        'uiWorkspace',
      ],
      apply(ctx) {
        const { employees, sessions } = window.__allriceSidebarFixtureData;
        const sidebarListeners = new Set(),
          settingsListeners = new Set(),
          accountListeners = new Set();
        const workspace = {
          viewerId: 'synthetic-person',
          organizationId: 'synthetic-org',
          workspaceId: 'synthetic-workspace',
          employees,
          employeeProfiles: [],
          sessions,
          sessionModels: [],
          canAdminister: false,
        };
        let identity = 1,
          accountOpen = false,
          launcher,
          held,
          holdWrite = false;
        const counters = {
          accountOpened: 0,
          notificationCalls: 0,
          bindings: 0,
          unbindings: 0,
          feedback: [],
          oldSignalAborted: false,
          lateResponseApplied: false,
          lateResponseRejected: false,
        };
        const fresh = () => ({
          scopeKey: `synthetic/person/employee/binding-${identity}`,
          preferences: {
            values: { streamingOutput: true },
            pending: false,
            error: null,
          },
        });
        let settings = fresh();
        const subscribe = (listeners) => (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        };
        const notify = (listeners) => {
          for (const listener of [...listeners]) listener();
        };
        const publishSettings = (value) => {
          settings = value;
          notify(settingsListeners);
        };
        const setAccount = (value) => {
          accountOpen = value;
          notify(accountListeners);
        };
        const archive = {
          sessions,
          filter: 'default',
          loading: false,
          error: '',
          loadError: '',
          legacyOverlayOpen: false,
          setFilter: () => {},
          reload: () => {},
          hasMore: () => false,
          loadPreview: () => {},
          loadMore: () => {},
        };
        let sidebar = {
          archive,
          settingsOpen: false,
          tree: {
            workspace,
            sessions,
            activeId: null,
            nativeReads: {},
            onPrepareSession: () => {},
            onSelectSession: () => {},
            onEmployeeNavigate: () => {},
            onNewSession: () => {},
            onDetails: () => {},
          },
        };
        const feedback = (open) => {
          // Native state is authoritative. Rebinding identical owner props must
          // not cause a parent render; a binding disposer is not a close action.
          if (sidebar.settingsOpen === open) return;
          sidebar = { ...sidebar, settingsOpen: open };
          counters.feedback.push(open);
          notify(sidebarListeners);
        };
        product.bindEmployeeSidebar(ctx, {
          getSnapshot: () => sidebar,
          subscribe: subscribe(sidebarListeners),
          createEmployee: () => {},
          openArchive: () => {},
          openEmployeeSettings: () => launcher?.openSettings(),
        });
        const current = (scope) =>
          !scope.signal.aborted && settings?.scopeKey === scope.key;
        const commit = (scope, enabled, late = false) => {
          if (!current(scope)) {
            counters.oldSignalAborted = scope.signal.aborted;
            counters.lateResponseRejected = true;
            return;
          }
          if (late) counters.lateResponseApplied = true;
          publishSettings({
            ...settings,
            preferences: {
              values: { streamingOutput: enabled },
              pending: false,
              error: null,
            },
          });
        };
        product.bindEmployeeSettings(ctx, {
          getSnapshot: () => settings,
          subscribe: subscribe(settingsListeners),
          renderSection(section) {
            if (section === 'computer')
              return React.createElement(
                'section',
                { 'aria-label': '合成电脑 owner' },
                React.createElement(
                  'p',
                  null,
                  '测试专用合成业务面，未验证真实电脑接入。',
                ),
                React.createElement(Button, null, '连接与管理电脑'),
              );
            if (section === 'work')
              return React.createElement(
                'section',
                { 'aria-label': '合成工作方式 owner' },
                React.createElement(
                  'p',
                  null,
                  '测试专用合成业务面，未验证真实工作设置。',
                ),
                React.createElement(Switch, {
                  label: '云端自动工作',
                  checked: false,
                  onChange: () => {},
                }),
                React.createElement(Switch, {
                  label: '电脑自动工作',
                  checked: false,
                  onChange: () => {},
                }),
              );
            return React.createElement(
              'section',
              { 'aria-label': '已链接应用' },
              '测试专用合成应用列表，未验证真实连接。',
            );
          },
          openAccountSettings(scope) {
            if (current(scope)) {
              counters.accountOpened++;
              setAccount(true);
            }
          },
          reloadPreferences() {},
          setStreamingOutput(scope, enabled) {
            if (!current(scope)) return;
            publishSettings({
              ...settings,
              preferences: { ...settings.preferences, pending: true },
            });
            if (holdWrite) held = { scope, enabled };
            else commit(scope, enabled);
          },
          bindNativeLauncher(value) {
            launcher = value;
            counters.bindings++;
            feedback(value.settingsOpen);
            return () => {
              counters.unbindings++;
              if (launcher === value) launcher = undefined;
            };
          },
          notificationPreferences: {
            reload() {
              counters.notificationCalls++;
            },
            set() {
              counters.notificationCalls++;
            },
          },
        });
        function AccountFixture() {
          const open = React.useSyncExternalStore(
            subscribe(accountListeners),
            () => accountOpen,
          );
          return React.createElement(
            Modal,
            {
              open,
              onClose: () => setAccount(false),
              title: '合成 AllRice 账号（仅接线测试）',
              closeLabel: '关闭合成账号',
            },
            React.createElement('p', null, '这不是旧 3.x 账号业务迁移验收。'),
            React.createElement('h3', null, '修改登录密码'),
            React.createElement(Button, null, '退出登录'),
            React.createElement('p', null, '文件存储'),
          );
        }
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'synthetic-settings-account' },
            AccountFixture,
          ),
        );
        const runtime = ctx.registry.get(product);
        if (!runtime || runtime.fibers.length !== 1)
          throw new Error('Expected one actual installed AllRice fiber');
        let composition = [...runtime.fibers][0];
        const parent = composition.parent;
        let oldOpen;
        const test = {
          evidence: () => ({
            ...counters,
            feedback: [...counters.feedback],
            settingsOpen: sidebar.settingsOpen,
            launcherReady: !!launcher,
            scopeKey: settings?.scopeKey ?? null,
            nativeShells: ctx.slots.entries('sidebar.settings').length,
            nativeLaunchers: ctx.slots.entries('settings.launcher').length,
          }),
          closeAccount: () => setAccount(false),
          setTheme: (theme) => ctx.theme.setTheme(theme),
          toggleSidebar: () => ctx.layout.toggleSidebar(),
          holdPreferenceWrite() {
            holdWrite = true;
          },
          switchIdentity() {
            identity++;
            publishSettings(fresh());
            setAccount(false);
          },
          releaseHeldPreferenceWrite() {
            if (!held) throw new Error('No actual preference action was held');
            const request = held;
            held = undefined;
            holdWrite = false;
            commit(request.scope, request.enabled, true);
          },
          revokeIdentity() {
            publishSettings(null);
            setAccount(false);
          },
          async unload() {
            oldOpen = launcher?.openSettings;
            await composition.dispose();
          },
          staleOpen() {
            oldOpen?.();
          },
          async rebuild() {
            composition = parent.plugin(product);
            await composition;
          },
          async pulseNativeShell() {
            for (let index = 0; index < 12; index++) {
              const remove = ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'synthetic-parent-render',
                  label: '合成父渲染探针',
                  order: 999,
                },
                () => null,
              );
              await new Promise(requestAnimationFrame);
              remove();
              await new Promise(requestAnimationFrame);
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
            // Released persisted history only; no send/run/model operation.
            ctx.uiWorkspace.openSession(
              'session-00000000-0000-4000-8000-000000000036',
            );
            window.__allriceSettingsIntegration = test;
          };
          const sessions = ctx.sessions.list.subscribe(open),
            workspaces = ctx.workspaces.list.subscribe(open);
          open();
          return () => {
            sessions();
            workspaces();
            if (window.__allriceSettingsIntegration === test)
              delete window.__allriceSettingsIntegration;
          };
        });
      },
    };
  },
});
