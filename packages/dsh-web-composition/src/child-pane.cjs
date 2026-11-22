/* global exports, URL, URLSearchParams, queueMicrotask */
/**
 * MET-278: native child catalog/body; only navigation, read-only presentation and
 * live title change. The authenticated Host must enforce MET-271 separately.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {typeof import('react')} React
 */
exports.registerChildPane = function registerChildPane(ctx, React) {
  const name = 'conversation.session.header.actions';
  // A declaration can precede ui-subagent's own entry. Follow the public
  // registration lifecycle, including native unload/reload, without cloning it.
  ctx.slots.inject(name, () => {
    let active = true;
    let queued = false;
    /** @type {ReturnType<typeof ctx.slots.entries>[number] | undefined} */
    let source;
    /** @type {(() => void) | undefined} */
    let remove;
    /** @type {ReturnType<typeof ctx.slots.entries>[number] | undefined} */
    let replacement;
    const reconcile = () => {
      queued = false;
      if (!active) return;
      const native = ctx.slots
        .entries(name)
        .find(
          (entry) =>
            entry !== replacement && entry.options.id === 'subagent-catalog',
        );
      if (native === source) return;
      source = native;
      remove?.();
      remove = undefined;
      replacement = undefined;
      if (!native) return;
      if (native.locale !== 'subagent' || typeof native.inject !== 'function')
        throw new Error('Native subagent catalog contract changed');
      const catalogInject =
        /** @type {(id: import('@deepseek-ai/dsh-subagent/client').SubagentAddress['parentSessionId']) => import('@deepseek-ai/dsh-client-ui-subagent/client').SubagentCatalogInjected} */ (
          /** @type {unknown} */ (native.inject)
        );
      /** @param {import('@deepseek-ai/dsh-subagent/client').SubagentAddress} address */
      const open = (address) => {
        const query = new URLSearchParams({
          parent: address.parentSessionId,
          mode: address.mode,
        });
        ctx.sidebarRight.openResource(
          `dsh-resource://subagentchat/session/${encodeURIComponent(address.childSessionId)}?${query}`,
          { kind: 'subagentchat', preferNewPane: false },
        );
      };
      remove = ctx.slots.register(
        {
          ...native.options,
          name,
          id: 'subagent-catalog',
          priority: -300,
          locale: native.locale,
          inject: (
            /** @type {import('@deepseek-ai/dsh-subagent/client').SubagentAddress['parentSessionId']} */ sessionId,
          ) => ({
            ...catalogInject(sessionId),
            openChild: open,
            openChildAside: open,
          }),
        },
        /** @type {import('@deepseek-ai/dsh-client-ui-slots').SlotComponent<import('@deepseek-ai/dsh-client-ui-subagent/client').SubagentCatalogActionProps>} */ (
          native.component
        ),
      );
      replacement = ctx.slots
        .entries(name)
        .find(
          (entry) =>
            entry !== native && entry.options.id === 'subagent-catalog',
        );
    };
    const schedule = () => {
      if (queued || !active) return;
      queued = true;
      queueMicrotask(reconcile);
    };
    const off = ctx.on('slots/changed', (key) => {
      if (key === name) schedule();
    });
    schedule();
    return () => {
      active = false;
      off();
      remove?.();
    };
  });

  ctx.slots.inject('conversation.composer', () =>
    ctx.slots.register(
      {
        name: 'conversation.composer',
        priority: -200,
        select: (owner) =>
          owner.session?.subagent ? { readOnly: true } : null,
      },
      () =>
        React.createElement(
          'div',
          {
            style: {
              padding: '12px',
              fontSize: '12px',
              color: 'var(--dsw-alias-label-tertiary)',
            },
            role: 'status',
          },
          '只读会话 · 由主员工安排后续工作',
        ),
    ),
  );

  ctx.slots.inject('sidebar.right.pane.tab.title', () =>
    ctx.slots.register(
      {
        name: 'sidebar.right.pane.tab.title',
        key: '@deepseek-ai/dsh-client-ui-subagent',
        priority: -200,
      },
      ({ useTabInfo, useSessions }) => {
        const { tab } = useTabInfo();
        const title = useSessions((snapshot) =>
          exports.childTaskTitle(tab.contentId, snapshot),
        );
        return React.createElement('span', { title }, title);
      },
    ),
  );
};

/**
 * A title is presentation, never an authorization fact. Unavailable or malformed
 * addresses use a human label, not the native internal id fallback.
 * @param {string} address
 * @param {import('@deepseek-ai/dsh-api-session-controller/client').SessionListState} snapshot
 */
exports.childTaskTitle = function childTaskTitle(address, snapshot) {
  try {
    const url = new URL(address);
    if (url.protocol !== 'dsh-resource:' || url.hostname !== 'subagentchat')
      return '子智能体';
    const childId =
      /** @type {import('@deepseek-ai/dsh-subagent/client').SubagentAddress['childSessionId']} */ (
        decodeURIComponent(url.pathname.split('/').pop() || '')
      );
    const parentId =
      /** @type {import('@deepseek-ai/dsh-subagent/client').SubagentAddress['parentSessionId']} */ (
        url.searchParams.get('parent') || ''
      );
    const summary = snapshot.byId[childId];
    const catalog =
      snapshot.projectionsBySession[parentId]?.values?.subagentCatalog;
    return (
      summary?.projectionValues?.subagent?.label ||
      catalog?.find((entry) => entry.id === childId)?.label ||
      summary?.title ||
      '子智能体'
    );
  } catch {
    return '子智能体';
  }
};
