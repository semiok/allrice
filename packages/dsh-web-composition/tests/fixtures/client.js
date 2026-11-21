/* global window */
// Browser-test package only. This file is excluded from the product tarball.
window.__ModuleLoader__.load({
  id: '@allrice/composition-test-fixture',
  factory: () => ({
    inject: ['sessions', 'workspaces', 'uiWorkspace', 'theme'],
    apply(ctx) {
      ctx.effect(() => {
        const test = {
          openSession: (id) => ctx.uiWorkspace.openSession(id),
          setTheme: (mode) => ctx.theme.setTheme(mode),
        };
        let opened = false;
        const open = () => {
          if (
            opened ||
            ctx.sessions.list.getSnapshot().phase !== 'ready' ||
            ctx.workspaces.list.getSnapshot().phase !== 'ready'
          )
            return;
          opened = true;
          ctx.uiWorkspace.openSession(
            'session-00000000-0000-4000-8000-000000000036',
          );
          window.__allriceCompositionTest = test;
        };
        const sessions = ctx.sessions.list.subscribe(open);
        const workspaces = ctx.workspaces.list.subscribe(open);
        open();
        return () => {
          sessions();
          workspaces();
          if (window.__allriceCompositionTest === test)
            delete window.__allriceCompositionTest;
        };
      });
    },
  }),
});
