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
  'envelope' | 'dsh_search' | 'dsh_broker_native' | 'dsh_assistant_native';

export type AllRiceToolRisk =
  'read_only' | 'managed_write' | 'side_effect' | 'secret_bearing';

export interface AllRiceToolManifestEntry {
  canonicalName: string;
  capability: SkillCapability;
  risk: AllRiceToolRisk;
  transport: AllRiceToolTransport;
  dshWireName?: string;
}

/** Frozen intrinsic tools for a personal custom employee. A Skill or published
 * template never grants these to another instance or delegated child. */
export const employeeCustomizationTools = [
  { name: 'workspace.employee.profile.update', capability: 'storage:write' },
  { name: 'workspace.employee.method.inspect', capability: 'storage:read' },
  {
    name: 'workspace.employee.method.save_candidate',
    capability: 'storage:write',
  },
  {
    name: 'workspace.employee.method.restore_candidate',
    capability: 'storage:write',
  },
  { name: 'workspace.employee.method.test', capability: 'storage:write' },
  { name: 'workspace.employee.method.test_status', capability: 'storage:read' },
  {
    name: 'workspace.employee.method.prepare_activation',
    capability: 'storage:write',
  },
  { name: 'workspace.employee.method.activate', capability: 'storage:write' },
] as const;

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
    canonicalName: 'workspace.employee.profile.update',
    capability: 'storage:write',
    risk: 'managed_write',
    transport: 'dsh_broker_native',
    dshWireName: 'workspace_employee_profile_update',
  },
  {
    canonicalName: 'workspace.employee.method.inspect',
    capability: 'storage:read',
    risk: 'read_only',
    transport: 'dsh_broker_native',
    dshWireName: 'workspace_employee_method_inspect',
  },
  {
    canonicalName: 'workspace.employee.method.save_candidate',
    capability: 'storage:write',
    risk: 'managed_write',
    transport: 'dsh_broker_native',
    dshWireName: 'workspace_employee_method_save_candidate',
  },
  {
    canonicalName: 'workspace.employee.method.restore_candidate',
    capability: 'storage:write',
    risk: 'managed_write',
    transport: 'dsh_broker_native',
    dshWireName: 'workspace_employee_method_restore_candidate',
  },
  {
    canonicalName: 'workspace.employee.method.test',
    capability: 'storage:write',
    risk: 'managed_write',
    transport: 'dsh_broker_native',
    dshWireName: 'workspace_employee_method_test',
  },
  {
    canonicalName: 'workspace.employee.method.test_status',
    capability: 'storage:read',
    risk: 'read_only',
    transport: 'dsh_broker_native',
    dshWireName: 'workspace_employee_method_test_status',
  },
  {
    canonicalName: 'workspace.employee.method.prepare_activation',
    capability: 'storage:write',
    risk: 'managed_write',
    transport: 'dsh_broker_native',
    dshWireName: 'workspace_employee_method_prepare_activation',
  },
  {
    canonicalName: 'workspace.employee.method.activate',
    capability: 'storage:write',
    risk: 'managed_write',
    transport: 'dsh_broker_native',
    dshWireName: 'workspace_employee_method_activate',
  },
  ...(['delegate', 'message', 'report', 'stop'] as const).map((action) => ({
    canonicalName: `assistant.${action}` as const,
    capability: 'model:invoke' as const,
    // Internal durable coordination/result publication, never general storage
    // access or approval to execute a delegated external side effect.
    risk: 'managed_write' as const,
    transport: 'dsh_assistant_native' as const,
    dshWireName: `assistant_${action}`,
  })),
  {
    canonicalName: 'assistant.development',
    capability: 'storage:write',
    risk: 'managed_write',
    transport: 'dsh_assistant_native',
    dshWireName: 'assistant_development',
  },
  {
    canonicalName: 'local.mcp.discover',
    capability: 'secret:use',
    risk: 'side_effect',
    transport: 'dsh_broker_native',
    dshWireName: 'local_mcp_discover',
  },
  {
    canonicalName: 'local.mcp.call',
    capability: 'secret:use',
    risk: 'side_effect',
    transport: 'dsh_broker_native',
    dshWireName: 'local_mcp_call',
  },
  {
    canonicalName: 'local.preview.open',
    capability: 'network:outbound',
    risk: 'side_effect',
    transport: 'dsh_broker_native',
    dshWireName: 'local_preview_open',
  },
  {
    canonicalName: 'local.browser.workspace',
    capability: 'network:outbound',
    risk: 'side_effect',
    transport: 'dsh_broker_native',
    dshWireName: 'local_browser_workspace',
  },
  {
    canonicalName: 'browser.workspace',
    capability: 'network:outbound',
    risk: 'side_effect',
    transport: 'dsh_broker_native',
    dshWireName: 'browser_workspace',
  },
  {
    canonicalName: 'workspace.reconciliation.export',
    capability: 'storage:write',
    risk: 'managed_write',
    transport: 'dsh_broker_native',
    dshWireName: 'workspace_reconciliation_export',
  },
  {
    canonicalName: 'workspace.skill.read',
    capability: 'storage:read',
    risk: 'read_only',
    transport: 'dsh_broker_native',
    dshWireName: 'workspace_skill_read',
  },
  {
    canonicalName: 'cloud.mcp.call',
    capability: 'secret:use',
    risk: 'side_effect',
    transport: 'dsh_broker_native',
    dshWireName: 'cloud_mcp_call',
  },
  {
    canonicalName: 'python.execute',
    capability: 'storage:write',
    risk: 'side_effect',
    transport: 'dsh_broker_native',
    dshWireName: 'python_execute',
  },
  {
    canonicalName: 'cloud.process.execute',
    capability: 'storage:write',
    risk: 'side_effect',
    transport: 'dsh_broker_native',
    dshWireName: 'cloud_process_execute',
  },
  {
    canonicalName: 'workspace.file.list',
    capability: 'storage:read',
    risk: 'read_only',
    transport: 'dsh_broker_native',
    dshWireName: 'workspace_file_list',
  },
  {
    canonicalName: 'workspace.project',
    capability: 'storage:write',
    risk: 'managed_write',
    transport: 'dsh_broker_native',
    dshWireName: 'workspace_project',
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
    transport: 'dsh_broker_native',
    dshWireName: 'web_fetch',
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
    canonicalName: 'image.generate',
    capability: 'storage:write',
    risk: 'managed_write',
    transport: 'dsh_broker_native',
    dshWireName: 'image_generate',
  },
  {
    canonicalName: 'image.edit',
    capability: 'storage:write',
    risk: 'managed_write',
    transport: 'dsh_broker_native',
    dshWireName: 'image_edit',
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
    canonicalName: 'local.file.inspect',
    capability: 'storage:read',
    risk: 'read_only',
    transport: 'dsh_broker_native',
    dshWireName: 'local_file_inspect',
  },
  {
    canonicalName: 'local.file.import',
    capability: 'storage:write',
    risk: 'managed_write',
    transport: 'dsh_broker_native',
    dshWireName: 'local_file_import',
  },
  {
    canonicalName: 'local.file.save',
    capability: 'storage:write',
    risk: 'managed_write',
    transport: 'dsh_broker_native',
    dshWireName: 'local_file_save',
  },
  {
    canonicalName: 'local.file.open',
    capability: 'storage:write',
    risk: 'side_effect',
    transport: 'dsh_broker_native',
    dshWireName: 'local_file_open',
  },
  {
    canonicalName: 'local.file.reveal',
    capability: 'storage:write',
    risk: 'side_effect',
    transport: 'dsh_broker_native',
    dshWireName: 'local_file_reveal',
  },
  {
    canonicalName: 'local.file.derive',
    capability: 'storage:write',
    risk: 'managed_write',
    transport: 'dsh_broker_native',
    dshWireName: 'local_file_derive',
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
    canonicalName: 'local.process.status',
    capability: 'storage:write',
    risk: 'read_only',
    transport: 'dsh_broker_native',
    dshWireName: 'local_process_status',
  },
  {
    canonicalName: 'local.process.stop',
    capability: 'storage:write',
    risk: 'managed_write',
    transport: 'dsh_broker_native',
    dshWireName: 'local_process_stop',
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
