import type {
  EmployeeKernelRequest,
  HarnessExecutionSnapshot,
  HarnessCapabilities,
  HarnessEvent,
  StorageObject,
} from '@allrice/contracts';

import type { CodexDynamicToolDefinition } from '../codex-app-server.js';

export interface HarnessToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
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
  workDirectory: string;
  executionEnvironment: Readonly<Record<string, string>>;
  signal: AbortSignal;
  attempt: number;
  generation: number;
  threadId?: string | null;
  tools: readonly CodexDynamicToolDefinition[];
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
}

export interface HarnessAdapter {
  readonly kind: 'codex' | 'dsh';
  readonly capabilities: HarnessCapabilities;
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
  close?(): Promise<void>;
}
