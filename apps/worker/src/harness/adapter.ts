import type { createRunDeliveryPort } from '../final-delivery/run-delivery.js';
import type {
  NativeRootOrigin,
  NativeModelFact,
  NativeModelSettlement,
  NativeRunExecutionBinding,
  NativeSubagentQueryTarget,
} from '@allrice/database';
import type { FinalDeliveryPort } from '../final-delivery/guard.js';
import type {
  EmployeeKernelRequest,
  InternalKernelRequest,
  DshNativeSkillSnapshot,
  EmployeeBaseSkillCatalog,
  EmployeeRuntimeScene,
  HarnessExecutionSnapshot,
  HarnessCapabilities,
  HarnessEvent,
  StorageObject,
  ImageMediaType,
  RuntimeNativeInputProof,
  NativeQuestionCheckpoint,
  QuestionWait,
  SubagentPreferences,
  NativeSubagentSummary,
} from '@allrice/contracts';

export interface HarnessToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  nativeSessionId?: string;
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

export interface HarnessImageInput {
  mediaType: ImageMediaType;
  data: string;
  name: string;
}

/** Private server-selected rollout mode. Never infer legacy from absent evidence. */
export type FinalDeliveryMode = 'checked_native_v1' | 'legacy';
/** Durable control references, not a persisted native capability or proof. */
export interface FinalDeliveryReplyOrigin {
  readonly schemaVersion: 1;
  readonly rootRunId: string;
  readonly nativeSessionId: string;
  readonly starts: readonly {
    readonly runEventId: string;
    readonly runEventSequence: number;
    readonly turnId: string;
  }[];
}

/** Private Worker control plane; never an input adoption acknowledgement. */
export interface HarnessExecutionInput {
  /** Captured Worker accounting only; never a model/browser authority. */
  nativeAccounting?: {
    bind(rootSessionId: string): {
      record(fact: NativeModelFact): Promise<unknown>;
      delivered(value: NativeModelSettlement['delivery']): void;
    };
  };
  nativeRunAuthority?: (generation: number) => () => Promise<unknown>;
  modelPreflight?: () => Promise<unknown>;
  /** Current platform rollout switch, shared with Web through PostgreSQL. */
  nativeQuestionMode?: 'legacy' | 'timed';
  /** Owner preference frozen when this Run was enqueued. */
  nativeQuestionWait?: QuestionWait;
  /** Ordinary employee caller only: original Run's server-frozen policy and
   * owner preferences. Missing/zero depth installs no delegation composition. */
  nativeSubagents?: SubagentPreferences;
  /** Server-loaded current human message before attachment/template augmentation.
   * Selects an existing tool transport only; database admission grants writes. */
  currentUserRequest?: string;
  /**
   * Worker-only, same-Run deterministic delivery check before native finish.
   * Employee jobs must bind this closure; optionality preserves other adapters/callers.
   * Never populated from kernel preferences, browser input or a model tool result.
   */
  finalDelivery?: FinalDeliveryPort;
  /** Independent checked Run path; authority and input pause stay Worker-owned. */
  runDelivery?: {
    rootRunId: string;
    bind(generation: number): ReturnType<typeof createRunDeliveryPort>;
    pauseInput(): Promise<void>;
  };
  /** Frozen governance evidence; never grants a native or Broker tool. */
  baseSkillCatalog?: EmployeeBaseSkillCatalog;
  questionWait?: {
    resume?: {
      sessionId: string;
      questionId: string;
      turnId: string;
      inputId: string;
      text: string;
    };
    /** Worker-only ports, never model or HTTP parameters. */
    park(
      checkpoint: NativeQuestionCheckpoint,
      receipt: {
        usage: HarnessExecutionResult['usage'];
        usageComplete: boolean;
        cacheUsageKnown: boolean;
      },
    ): Promise<void>;
    adopted(proof: RuntimeNativeInputProof): Promise<void>;
    /** Original dispatch's private receipt port. Called only after the exact
     * native child has closed; never reconstructed from RPC/JSON or tool data.
     * This settles a canceled dispatch, not model usage or new execution. */
    confirmStopped?(receipt: {
      nativeSessionId: string;
      runtimeId: string;
    }): Promise<unknown>;
  };
  /** Trusted Worker progress port. Never supplied by model/browser arguments. */
  progress?: (
    request: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  kernel: EmployeeKernelRequest | InternalKernelRequest;
  providerSnapshot: HarnessExecutionSnapshot;
  storageObjects: StorageObject[];
  images?: readonly HarnessImageInput[];
  nativeSkills?: DshNativeSkillSnapshot[];
  /** Server-bound authorization for all model sends, native retries and
   * compaction. No model-supplied dependency list is accepted. */
  contentGuard?: {
    generationId: string;
    nativeContextKey?: string;
    check: () => Promise<void>;
    scenes?: EmployeeRuntimeScene[];
    loadScene?: (selection: {
      sceneId: string;
      sceneDigest: string;
    }) => Promise<Record<string, unknown>>;
    adoptScene?: (evidence: {
      sceneId: string;
      sceneDigest: string;
      receiptId: string;
      nativeSessionId: string;
      callId: string;
    }) => Promise<Record<string, unknown>>;
  };
  workDirectory: string;
  executionEnvironment: Readonly<Record<string, string>>;
  signal: AbortSignal;
  attempt: number;
  generation: number;
  maxOutputTokens?: number;
  threadId?: string | null;
  /** Trusted Worker closure only. Real lease tokens never enter the kernel,
   * native environment, RPC or events. A returned pin has committed in SQL. */
  nativeBinding?: {
    prepare: (
      request: Pick<
        NativeSessionDescriptor,
        'nativeSessionId' | 'storageContextKey'
      >,
    ) => Promise<{
      binding: NativeSessionPin | null;
      origin?: NativeRootOrigin | null;
      /** SQL-verified per-Run fact; stays in this trusted closure, never RPC. */
      executionBinding?: NativeRunExecutionBinding | null;
      /** A pin/prior adoption/retry cannot create an empty replacement. */
      requiresRecovery: boolean;
      generation?: number;
    }>;
    bind: (descriptor: NativeSessionDescriptor) => Promise<{
      binding: NativeSessionPin;
      generation?: number;
    }>;
  };
  /**
   * Employee-authorized Tool Broker names before per-turn activation.
   *
   * `tools` remains the only callable set for this turn. Adapters use this
   * directory only to distinguish an intentionally inactive Skill from a
   * broken Skill whose required tool is not authorized at all.
   */
  authorizedToolNames?: readonly string[];
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
  waitingForUser?: { questionId: string; pauseId?: string };
  usageComplete?: boolean;
  cacheUsageKnown?: boolean;
  costEstimateAvailable?: boolean;
  /** Frozen-tariff upper bound, never a provider invoice or proven cash charge. */
  estimatedCostCents?: number | null;
  billingMode?: 'subscription';
  costBasis?: 'conservative_upper_bound' | 'unknown' | 'not_applicable';
  subscriptionSnapshotDigest?: string;
  priceSnapshotDigest?: string;
  costCurrency?: string;
  actualCostKnown?: false;
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

export interface HarnessRuntimeClosureSnapshot {
  id: string;
  threadId: string;
  nativeArtifactId: string | null;
  state: 'closing' | 'unconfirmed';
  processState: 'running' | 'exited' | 'unknown';
  stdioClosed: boolean;
  exitCode: number | null;
  signal: string | null;
  shutdownAcknowledged: boolean | null;
  wrapperCleanupConfirmed: boolean | null;
  terminationAttempted: string | null;
}

export interface HarnessRuntimeProcessSnapshot {
  id: string;
  organizationId: string;
  workspaceId: string;
  sessionId: string | null;
  internalTask?: InternalKernelRequest['internalTask'];
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
    runId?: string;
    inputKind?: 'steer_current' | 'ask_user';
  }): Promise<void | RuntimeNativeInputProof>;
  compact?(input: { threadId: string }): Promise<void>;
  recover?(input: { threadId: string }): Promise<void>;
  runtimeInventory?(): readonly HarnessRuntimeProcessSnapshot[];
  runtimeClosureInventory?(): readonly HarnessRuntimeClosureSnapshot[];
  nativeSubagentSummary?(
    target: NativeSubagentQueryTarget,
    signal: AbortSignal,
    liveOnly?: boolean,
  ): Promise<NativeSubagentSummary | undefined>;
  /** Idle process close runs only while this returns true. */
  setIdleCloseGate?(gate: () => boolean): void;
  close?(): Promise<void>;
}
import type {
  NativeSessionDescriptor,
  NativeSessionPin,
} from '@allrice/database';
