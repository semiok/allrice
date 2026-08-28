import type {
  EmployeeKernelRequest,
  DshNativeSkillSnapshot,
  HarnessExecutionSnapshot,
  HarnessCapabilities,
  HarnessEvent,
  StorageObject,
} from '@allrice/contracts';

export interface HarnessToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface HarnessToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface HarnessToolResult {
  modelContent: string;
  summary: string;
  itemCount?: number;
}

export interface HarnessExecutionInput {
  kernel: EmployeeKernelRequest;
  providerSnapshot: HarnessExecutionSnapshot;
  storageObjects: StorageObject[];
  nativeSkills?: DshNativeSkillSnapshot[];
  workDirectory: string;
  executionEnvironment: Readonly<Record<string, string>>;
  signal: AbortSignal;
  attempt: number;
  generation: number;
  maxOutputTokens?: number;
  threadId?: string | null;
  tools: readonly HarnessToolDefinition[];
  onToolCall?: (call: HarnessToolCall) => Promise<HarnessToolResult>;
  onEvent: (event: HarnessEvent) => Promise<void>;
  onThreadBound?: (input: {
    threadId: string;
    resumed: boolean;
    replacedThreadId: string | null;
  }) => Promise<{ generation?: number } | void>;
  onTurnStarted?: (input: {
    threadId: string;
    turnId: string;
  }) => Promise<void>;
}

export interface HarnessExecutionResult {
  answer: string;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  };
  provider: string;
  model: string;
  threadId?: string | null;
  turnId?: string | null;
  nativeContextPressure?: {
    asOfSeq?: number;
    pressureTokens?: number;
    projectedTokens?: number;
    contextWindow: number;
  } | null;
}

export interface HarnessRuntimeProcessSnapshot {
  id: string;
  organizationId: string;
  workspaceId: string;
  sessionId: string;
  ownerId: string;
  threadId: string;
  providerRoute: string;
  model: string;
  reasoningEffort: string;
  profileFingerprint: string;
  nativeTools: string[];
  startedAt: string;
  lastActivityAt: string;
}

/**
 * Provider boundary owned by AllRice ChatFlow Runtime.
 *
 * A HarnessAdapter translates native Harness sessions and events into the
 * tenant-authorized ChatFlow execution contract. It must not move product
 * Session/Run authority, credentials, durable replay or Tool Broker policy
 * into the provider runtime.
 */
export interface HarnessAdapter {
  readonly kind: 'codex' | 'dsh';
  readonly capabilities: HarnessCapabilities;
  /** Who mutates the live context window; ChatFlow still owns checkpoints. */
  readonly contextStrategy: 'chatflow-managed' | 'harness-native';
  isConfigured?(snapshot: HarnessExecutionSnapshot): boolean;
  execute(input: HarnessExecutionInput): Promise<HarnessExecutionResult>;
  interrupt?(input: { threadId: string; turnId: string }): Promise<void>;
  steer?(input: {
    threadId: string;
    turnId: string;
    message: string;
    clientUserMessageId: string;
  }): Promise<void>;
  compact?(input: { threadId: string }): Promise<void>;
  recover?(input: { threadId: string }): Promise<void>;
  runtimeInventory?(): readonly HarnessRuntimeProcessSnapshot[];
  close?(): Promise<void>;
}
