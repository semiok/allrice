import { HandlerError } from '../errors.js';
import type { riceToolDefinitions } from './definitions.js';
import { createAutomation } from './handlers/automation.js';
import { runManagedBrowser } from './handlers/browser.js';
import { createWorkspaceExport } from './handlers/delivery.js';
import { executeLocalBridgeTool } from './handlers/local.js';
import {
  executeResearchTool,
  type ResearchToolName,
} from './handlers/research.js';
import {
  listWorkspaceFiles,
  readWorkspaceDocument,
  readWorkspaceFile,
  rememberWorkspaceMemory,
  searchWorkspaceMemory,
  searchWorkspaceSessions,
} from './handlers/workspace.js';
import type {
  RiceToolHandler,
  RiceToolHandlerCategory,
  RiceToolHandlerRegistration,
} from './types.js';

type RiceToolName = (typeof riceToolDefinitions)[number]['name'];

function registration(
  category: RiceToolHandlerCategory,
  execute: RiceToolHandler,
): RiceToolHandlerRegistration {
  return Object.freeze({ category, execute });
}

function researchHandler(name: ResearchToolName): RiceToolHandler {
  return ({ input, arguments: args }) =>
    executeResearchTool({
      name,
      arguments: args,
      overrides: {
        ...(input.codexSearch ? { codexSearch: input.codexSearch } : {}),
        ...(input.wechatSearch ? { wechatSearch: input.wechatSearch } : {}),
        ...(input.wechatRead ? { wechatRead: input.wechatRead } : {}),
      },
    });
}

/**
 * The canonical Tool Broker dispatch table. `satisfies` intentionally ties
 * every executable definition to exactly one handler at compile time: adding
 * a manifest-backed tool without registering its handler fails typecheck.
 */
export const riceToolHandlerRegistry = Object.freeze({
  'workspace.file.list': registration('workspace', listWorkspaceFiles),
  'workspace.file.read': registration('workspace', readWorkspaceFile),
  'workspace.document.read': registration('workspace', readWorkspaceDocument),
  'workspace.memory.search': registration('workspace', searchWorkspaceMemory),
  'workspace.memory.remember': registration(
    'workspace',
    rememberWorkspaceMemory,
  ),
  'workspace.session.search': registration(
    'workspace',
    searchWorkspaceSessions,
  ),
  'web.search': registration('research', researchHandler('web.search')),
  'web.fetch': registration('research', researchHandler('web.fetch')),
  'browser.run': registration('managed_browser', runManagedBrowser),
  'wechat.article.search': registration(
    'research',
    researchHandler('wechat.article.search'),
  ),
  'wechat.article.read': registration(
    'research',
    researchHandler('wechat.article.read'),
  ),
  'market.quote': registration('research', researchHandler('market.quote')),
  'market.history': registration('research', researchHandler('market.history')),
  'workspace.export.create': registration('delivery', createWorkspaceExport),
  'local.fs.list': registration('local_bridge', executeLocalBridgeTool),
  'local.fs.search': registration('local_bridge', executeLocalBridgeTool),
  'local.fs.read': registration('local_bridge', executeLocalBridgeTool),
  'local.fs.write': registration('local_bridge', executeLocalBridgeTool),
  'local.fs.mkdir': registration('local_bridge', executeLocalBridgeTool),
  'local.git.status': registration('local_bridge', executeLocalBridgeTool),
  'local.git.diff': registration('local_bridge', executeLocalBridgeTool),
  'automation.create': registration('automation', createAutomation),
} satisfies Record<RiceToolName, RiceToolHandlerRegistration>);

export function resolveRiceToolHandler(
  name: string,
): RiceToolHandlerRegistration | null {
  if (!Object.hasOwn(riceToolHandlerRegistry, name)) return null;
  return riceToolHandlerRegistry[name as RiceToolName];
}

export function requireRiceToolHandler(name: string) {
  const handler = resolveRiceToolHandler(name);
  if (handler) return handler;
  throw new HandlerError('TOOL_NOT_ALLOWED', `不允许调用工具 ${name}`, false);
}
