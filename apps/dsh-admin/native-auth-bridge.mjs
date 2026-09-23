/* global process */

// Trusted host plugin, never a model tool. The launch credential crosses only
// Node's parent/child IPC channel and is never injected into browser HTML.
export const name = 'allrice-admin-native-auth';
export const inject = ['connection'];
export function apply(ctx) {
  if (!process.send) throw new Error('Administrator gateway IPC is required');
  process.send({
    type: 'allrice/admin-native-auth',
    url: ctx.connection.authenticatedUrl(
      `http://127.0.0.1:${process.env.ALLRICE_DSH_WEBUI_PORT ?? '3080'}`,
    ),
  });
}
