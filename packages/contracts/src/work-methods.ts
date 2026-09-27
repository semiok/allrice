import { z } from 'zod';

export const WorkMethodSchema = z.enum([
  'cloud_compute',
  'cloud_browser',
  'cloud_search',
  'cloud_files',
  'cloud_apps',
  'cloud_automation',
  'bridge_compute',
  'bridge_browser',
  'bridge_files',
  'bridge_apps',
]);
export type WorkMethod = z.infer<typeof WorkMethodSchema>;
export const workMethodLabels: Record<WorkMethod, string> = {
  cloud_compute: '云端-计算',
  cloud_browser: '云端-浏览器',
  cloud_search: '云端-检索',
  cloud_files: '云端-文件',
  cloud_apps: '云端-应用',
  cloud_automation: '云端-定时任务',
  bridge_compute: 'Bridge-计算',
  bridge_browser: 'Bridge-浏览器',
  bridge_files: 'Bridge-文件',
  bridge_apps: 'Bridge-应用',
};

/** Only synchronous tools whose successful return confirms work. Async tools
 * can return waiting/unavailable without execution; use their operation ledger. */
export const completedToolWorkMethods: Readonly<Record<string, WorkMethod>> = {
  'web.search': 'cloud_search',
  'web.fetch': 'cloud_search',
  'wechat.article.search': 'cloud_search',
  'wechat.article.read': 'cloud_search',
  'market.quote': 'cloud_search',
  'market.history': 'cloud_search',
  'workspace.memory.search': 'cloud_search',
  'workspace.session.search': 'cloud_search',
  'workspace.file.list': 'cloud_files',
  'workspace.file.read': 'cloud_files',
  'workspace.document.read': 'cloud_files',
  'workspace.export.create': 'cloud_files',
  'workspace.reconciliation.export': 'cloud_files',
  'browser.run': 'cloud_browser',
  'automation.create': 'cloud_automation',
  'local.fs.list': 'bridge_files',
  'local.fs.search': 'bridge_files',
  'local.fs.read': 'bridge_files',
  'local.git.status': 'bridge_files',
  'local.git.diff': 'bridge_files',
};

/** Require both the frozen action and execution target; never guess from a
 * tool-name prefix, model prose, configured capability, or connected device. */
export function operationWorkMethod(
  action: string,
  target: string,
): WorkMethod | undefined {
  const methods: Record<string, Record<string, WorkMethod>> = {
    cloud_sandbox: {
      'cloud.process.execute': 'cloud_compute',
      'cloud.browser.act': 'cloud_browser',
      'cloud.browser.observe': 'cloud_browser',
    },
    cloud_mcp: { 'cloud.mcp.call': 'cloud_apps' },
    rice_bridge: {
      'local.process.execute': 'bridge_compute',
      'local.browser.act': 'bridge_browser',
      'local.browser.observe': 'bridge_browser',
      'local.fs.write': 'bridge_files',
      'local.fs.mkdir': 'bridge_files',
      'local.mcp.call': 'bridge_apps',
    },
  };
  return Object.hasOwn(methods, target) &&
    Object.hasOwn(methods[target]!, action)
    ? methods[target]![action]
    : undefined;
}
