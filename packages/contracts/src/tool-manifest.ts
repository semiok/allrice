import type { SkillCapability } from './skills.ts';

/**
 * Stable transport used to expose one canonical AllRice tool to DSH.
 *
 * `envelope` tools remain available through the legacy structured envelope,
 * `dsh_search` is the intentionally special hosted-search integration, and
 * `dsh_broker_native` tools are registered natively and delegated back to the
 * tenant-scoped AllRice Tool Broker.
 */
export type AllRiceToolTransport =
  'envelope' | 'dsh_search' | 'dsh_broker_native';

export type AllRiceToolRisk =
  'read_only' | 'managed_write' | 'side_effect' | 'secret_bearing';

export interface AllRiceToolManifestEntry {
  canonicalName: string;
  capability: SkillCapability;
  risk: AllRiceToolRisk;
  transport: AllRiceToolTransport;
  dshWireName?: string;
}

/**
 * Metadata-only single source of truth for the governed AllRice tool surface.
 *
 * Rich JSON Schema, Tool Broker handlers, DSH prompts and presentation remain
 * next to their execution boundaries. Keeping those out of this manifest is
 * deliberate: the DSH schema DSL cannot preserve every Tool Broker constraint,
 * and the Tool Broker remains the final validation and authorization boundary.
 */
export const allRiceToolManifest = [
  {
    canonicalName: 'workspace.file.list',
    capability: 'storage:read',
    risk: 'read_only',
    transport: 'envelope',
  },
  {
    canonicalName: 'workspace.file.read',
    capability: 'storage:read',
    risk: 'read_only',
    transport: 'envelope',
  },
  {
    canonicalName: 'workspace.document.read',
    capability: 'storage:read',
    risk: 'read_only',
    transport: 'dsh_broker_native',
    dshWireName: 'workspace_document_read',
  },
  {
    canonicalName: 'workspace.memory.search',
    capability: 'storage:read',
    risk: 'read_only',
    transport: 'dsh_broker_native',
    dshWireName: 'workspace_memory_search',
  },
  {
    canonicalName: 'workspace.memory.remember',
    capability: 'storage:write',
    risk: 'managed_write',
    transport: 'dsh_broker_native',
    dshWireName: 'workspace_memory_remember',
  },
  {
    canonicalName: 'workspace.session.search',
    capability: 'storage:read',
    risk: 'read_only',
    transport: 'dsh_broker_native',
    dshWireName: 'workspace_session_search',
  },
  {
    canonicalName: 'web.search',
    capability: 'network:outbound',
    risk: 'read_only',
    transport: 'dsh_search',
    dshWireName: 'web_search',
  },
  {
    canonicalName: 'web.fetch',
    capability: 'network:outbound',
    risk: 'read_only',
    transport: 'envelope',
  },
  {
    canonicalName: 'browser.run',
    capability: 'network:outbound',
    risk: 'read_only',
    transport: 'dsh_broker_native',
    dshWireName: 'browser_run',
  },
  {
    canonicalName: 'wechat.article.search',
    capability: 'network:outbound',
    risk: 'read_only',
    transport: 'dsh_broker_native',
    dshWireName: 'wechat_article_search',
  },
  {
    canonicalName: 'wechat.article.read',
    capability: 'network:outbound',
    risk: 'read_only',
    transport: 'dsh_broker_native',
    dshWireName: 'wechat_article_read',
  },
  {
    canonicalName: 'market.quote',
    capability: 'network:outbound',
    risk: 'read_only',
    transport: 'dsh_broker_native',
    dshWireName: 'market_quote',
  },
  {
    canonicalName: 'market.history',
    capability: 'network:outbound',
    risk: 'read_only',
    transport: 'dsh_broker_native',
    dshWireName: 'market_history',
  },
  {
    canonicalName: 'workspace.export.create',
    capability: 'storage:write',
    risk: 'managed_write',
    transport: 'dsh_broker_native',
    dshWireName: 'workspace_export_create',
  },
  {
    canonicalName: 'local.fs.list',
    capability: 'storage:read',
    risk: 'read_only',
    transport: 'dsh_broker_native',
    dshWireName: 'local_fs_list',
  },
  {
    canonicalName: 'local.fs.search',
    capability: 'storage:read',
    risk: 'read_only',
    transport: 'dsh_broker_native',
    dshWireName: 'local_fs_search',
  },
  {
    canonicalName: 'local.fs.read',
    capability: 'storage:read',
    risk: 'read_only',
    transport: 'dsh_broker_native',
    dshWireName: 'local_fs_read',
  },
  {
    canonicalName: 'local.fs.write',
    capability: 'storage:write',
    risk: 'managed_write',
    transport: 'dsh_broker_native',
    dshWireName: 'local_fs_write',
  },
  {
    canonicalName: 'local.process.execute',
    capability: 'storage:write',
    risk: 'side_effect',
    transport: 'dsh_broker_native',
    dshWireName: 'local_process_execute',
  },
  {
    canonicalName: 'local.fs.mkdir',
    capability: 'storage:write',
    risk: 'managed_write',
    transport: 'dsh_broker_native',
    dshWireName: 'local_fs_mkdir',
  },
  {
    canonicalName: 'local.git.status',
    capability: 'storage:read',
    risk: 'read_only',
    transport: 'dsh_broker_native',
    dshWireName: 'local_git_status',
  },
  {
    canonicalName: 'local.git.diff',
    capability: 'storage:read',
    risk: 'read_only',
    transport: 'dsh_broker_native',
    dshWireName: 'local_git_diff',
  },
  {
    canonicalName: 'automation.create',
    capability: 'automation:write',
    risk: 'side_effect',
    transport: 'dsh_broker_native',
    dshWireName: 'automation_create',
  },
] as const satisfies readonly AllRiceToolManifestEntry[];

export type AllRiceToolName =
  (typeof allRiceToolManifest)[number]['canonicalName'];
