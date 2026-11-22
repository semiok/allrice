import type { Context } from '@deepseek-ai/cordis';
import type { ComponentType } from 'react';
import type { ExpandButtonProps } from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type {
  HostObservable,
  StoredEntry,
  StoreHandle,
} from '@deepseek-ai/dsh-client-ui-slots';

// StoredEntry deliberately erases its store's generic types. Recover only the
// public component's contract while retaining the identical native handle.
type CornerState = Parameters<Parameters<ExpandButtonProps['useStore']>[0]>[0];
type CornerStore = StoreHandle<
  CornerState,
  {
    [K in keyof ExpandButtonProps['actions']]: (
      draft: CornerState,
      ...args: Parameters<ExpandButtonProps['actions'][K]>
    ) => void;
  }
>;

type CornerInjected = {
  hooks: {
    shortcuts: HostObservable<
      Parameters<Parameters<ExpandButtonProps['useShortcuts']>[0]>[0]
    >;
  };
};

/** Keep the shipped button, store and shortcuts; Start is a native page open. */
export function nativeStartCorner(
  ctx: Context,
  Native: ComponentType<ExpandButtonProps>,
) {
  return function StartCorner(props: ExpandButtonProps) {
    return (
      <Native
        {...props}
        actions={{
          ...props.actions,
          setExpanded(sessionId, expanded) {
            if (!expanded)
              return props.actions.setExpanded(sessionId, expanded);
            if (ctx.sidebarRight.mounted.getSnapshot() === sessionId)
              ctx.sidebarRight.openTab('guide');
          },
        }}
      />
    );
  };
}

export function apply(ctx: Context) {
  ctx.inject(['slots', 'sidebarRight'], (scope) => {
    const name = 'conversation.session.header.corner';
    scope.slots.inject(name, () => {
      let active = true;
      let queued = false;
      let source: StoredEntry | undefined;
      let replacement: StoredEntry | undefined;
      let remove: (() => void) | undefined;
      const reconcile = () => {
        queued = false;
        if (!active) return;
        const native = scope.slots
          .entries(name)
          .find((entry) => entry !== replacement);
        if (native === source) return;
        source = native;
        remove?.();
        remove = undefined;
        replacement = undefined;
        if (!native) return;
        if (!native.store || native.locale !== 'sidebarRight' || !native.inject)
          throw Error('Native sidebar corner contract changed');
        const Native = native.component as ComponentType<ExpandButtonProps>;
        remove = scope.slots.register(
          {
            ...native.options,
            name,
            priority: -100,
            store: native.store as CornerStore,
            locale: native.locale,
            inject: native.inject as () => CornerInjected,
          },
          nativeStartCorner(scope, Native),
        );
        replacement = scope.slots.entriesOfSlot(name)[0];
      };
      const schedule = () => {
        if (queued || !active) return;
        queued = true;
        queueMicrotask(reconcile);
      };
      const off = scope.on('slots/changed', (key) => {
        if (key === name) schedule();
      });
      schedule();
      return () => {
        active = false;
        off();
        remove?.();
      };
    });
  });
}
