/* global exports */
exports.inject = ['slots', 'theme'];

/**
 * Apply the employee Web presentation through native public composition seams.
 * @param {import('@deepseek-ai/cordis').Context & {
 *   slots: import('@deepseek-ai/dsh-client-ui-renderer/client').SlotRegistry,
 *   theme: import('@deepseek-ai/dsh-client-ui-theme/client').ThemeRuntime
 * }} ctx
 */
exports.apply = function apply(ctx) {
  const Hidden = () => null;
  const inputs = /** @type {const} */ ([
    'conversation.input.permission',
    'conversation.input.model',
  ]);
  for (const name of inputs) {
    ctx.slots.inject(name, () =>
      ctx.slots.register({ name, priority: -100 }, Hidden),
    );
  }
  const utilities = 'conversation.session.header.utilities';
  ctx.slots.inject(utilities, () =>
    ctx.slots.register(
      { name: utilities, id: 'session-log-download', priority: -100 },
      Hidden,
    ),
  );
  const dock = 'conversation.composer.dock';
  ctx.slots.inject(dock, function* () {
    for (const id of ['activity', 'usage']) {
      yield ctx.slots.register({ name: dock, id, priority: -100 }, Hidden);
    }
  });
  // Existing packages/ui/src/tokens.css text colors. Dark mode follows the
  // native static palette, avoiding an alias referencing its own override.
  ctx.effect(
    () =>
      ctx.theme.overrideTokens('@allrice/dsh-web-composition', {
        '--dsw-alias-label-secondary': {
          light: 'rgb(94, 99, 104)',
          dark: 'var(--dsw-static-neutral-bluish-300)',
        },
        '--dsw-alias-label-tertiary': {
          light: 'rgb(120, 124, 131)',
          dark: 'var(--dsw-static-neutral-bluish-400)',
        },
      }),
    'AllRice employee Web text tokens',
  );
};
