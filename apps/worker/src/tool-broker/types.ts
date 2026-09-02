import type {
  createTraceableMemory,
  isManagedBrowserTaskCancelRequested,
} from '@allrice/database';
import type { ExecutionContext, SkillCapability } from '@allrice/contracts';

import type { searchCodexHostedWeb } from '../codex-search-broker.js';
import type { runManagedBrowserTask } from '../managed-browser.js';
import type { getMarketHistory, getMarketQuote } from '../market-data.js';
import type { fetchPublicWebPage } from '../web-fetch.js';
import type {
  readWechatArticle,
  searchWechatArticles,
} from '../wechat-articles.js';

export interface RiceToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface RiceToolResult {
  modelContent: string;
  summary: string;
  itemCount?: number;
}

export interface ResearchToolOverrides {
  codexSearch?: typeof searchCodexHostedWeb;
  webFetch?: typeof fetchPublicWebPage;
  wechatSearch?: typeof searchWechatArticles;
  wechatRead?: typeof readWechatArticle;
  marketQuote?: typeof getMarketQuote;
  marketHistory?: typeof getMarketHistory;
}

export type ManagedBrowserCancellationCheck =
  typeof isManagedBrowserTaskCancelRequested;

export interface RiceToolExecutionInput {
  context: ExecutionContext;
  capabilities: SkillCapability[];
  storageRoot: string;
  skillVersionIds?: string[];
  sessionId?: string;
  employeeId?: string;
  userMessageId?: string;
  userRequest?: string;
  platformTestRunId?: string;
  platformActorLabel?: string;
  signal?: AbortSignal;
  call: RiceToolCall;
  codexSearch?: ResearchToolOverrides['codexSearch'];
  wechatSearch?: ResearchToolOverrides['wechatSearch'];
  wechatRead?: ResearchToolOverrides['wechatRead'];
  managedBrowserRun?: typeof runManagedBrowserTask;
  managedBrowserCancelCheck?: ManagedBrowserCancellationCheck;
  managedBrowserCancelPollIntervalMs?: number;
  managedBrowserJobAttempt?: number;
  managedBrowserJobLeaseToken?: string;
  memoryCreate?: typeof createTraceableMemory;
}

export interface RiceToolHandlerContext {
  input: RiceToolExecutionInput;
  arguments: Record<string, unknown>;
}

export type RiceToolHandler = (
  context: RiceToolHandlerContext,
) => Promise<RiceToolResult>;

export type RiceToolHandlerCategory =
  | 'workspace'
  | 'research'
  | 'managed_browser'
  | 'delivery'
  | 'local_bridge'
  | 'automation';

export interface RiceToolHandlerRegistration {
  category: RiceToolHandlerCategory;
  execute: RiceToolHandler;
}
