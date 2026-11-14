import type {
  createTraceableMemory,
  createRememberedMemoryCandidate,
  isManagedBrowserTaskCancelRequested,
  TechnicalTaskLease,
  QualityLease,
  RunMemoryAuthority,
  executeEmployeeReferenceTool,
} from '@allrice/database';
import type {
  ExecutionContext,
  SkillCapability,
  DshNativeSkillSnapshot,
  FrozenMcpTool,
  LocalMcpSnapshot,
  PersonalSceneSkillResource,
  EmployeeDocuments,
} from '@allrice/contracts';

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
  nativeSessionId?: string;
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
  frozenMcpTools?: readonly FrozenMcpTool[];
  localMcp?: LocalMcpSnapshot;
  storageRoot: string;
  skillVersionIds?: string[];
  nativeSkills?: readonly DshNativeSkillSnapshot[];
  /** Worker-owned generation and lease closure, never reconstructed from args. */
  readPersonalSceneResource?: (
    contentRef: string,
    path: string,
  ) => Promise<PersonalSceneSkillResource>;
  /** Bound by Worker to this exact Run/generation/lease; never model input. */
  executeReferenceTool?: (
    name: Parameters<typeof executeEmployeeReferenceTool>[3],
    args: unknown,
    signal?: AbortSignal,
  ) => ReturnType<typeof executeEmployeeReferenceTool>;
  sessionId?: string;
  employeeId?: string;
  userMessageId?: string;
  userRequest?: string;
  /** Private Worker binding, never accepted in tool arguments. */
  technicalTaskLease?: TechnicalTaskLease;
  /** Worker-owned scope and lease; never parsed from model arguments. */
  memoryReadAuthority?: RunMemoryAuthority;
  /** Same frozen documents sent to native run/begin, never accepted from args. */
  employeeDocuments?: EmployeeDocuments;
  technicalTaskId?: string;
  /** Private fixed-case driver hook, never parsed from model/tool JSON. */
  qualityLiveProbe?: {
    checkId: string;
    lease: QualityLease;
    syncOnce: (signal: AbortSignal) => Promise<{ updateId: string }>;
  };
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
  memoryCandidateCreate?: typeof createRememberedMemoryCandidate;
}

export interface RiceToolHandlerContext {
  input: RiceToolExecutionInput;
  arguments: Record<string, unknown>;
}

export type RiceToolHandler = (
  context: RiceToolHandlerContext,
) => Promise<RiceToolResult>;

export type RiceToolHandlerCategory =
  | 'cloud_runner'
  | 'cloud_mcp'
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
