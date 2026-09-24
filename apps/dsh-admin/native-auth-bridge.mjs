/* global process */

// Trusted host plugin, never a model tool. The launch credential crosses only
// Node's parent/child IPC channel and is never injected into browser HTML.
export const name = 'allrice-admin-native-auth';
export const inject = ['connection', 'loader', 'timer'];
export function apply(ctx) {
  if (!process.send) throw new Error('Administrator gateway IPC is required');
  process.send({
    type: 'allrice/admin-native-auth',
    url: ctx.connection.authenticatedUrl(
      `http://127.0.0.1:${process.env.ALLRICE_DSH_WEBUI_PORT ?? '3080'}`,
    ),
  });
  const report = () => {
    if (!process.connected) return;
    try {
      process.send({
        type: 'allrice/admin-native-capabilities',
        components: nativeComponentFacts(ctx.loader.entries()),
      });
    } catch {
      /* An unreadable loader expires to unknown in the gateway. */
    }
  };
  ctx.setInterval(report, 5000);
  report();
}

// Fiber states match the pinned Cordis loader used by DSH rc.3. Unknown states
// remain unknown on future upgrades; never inspect plugin configs or errors.
export function nativeComponentFacts(entries) {
  return [...entries]
    .filter((entry) => !entry.options.group)
    .map((entry) => {
      const moduleName = entry.options.name;
      const id = String(entry.id)
        .replace(/[^a-zA-Z0-9_.:@/-]/g, '_')
        .slice(0, 200);
      const name = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(moduleName)
        ? moduleName
        : `local:${String(entry.options.id).replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
      const state = entry.disabled
        ? 'disabled'
        : ({ 0: 'pending', 1: 'pending', 2: 'active', 3: 'failed' }[
            entry.fiber?.state
          ] ?? 'unknown');
      return { id, name: name.slice(0, 200), state };
    });
}
