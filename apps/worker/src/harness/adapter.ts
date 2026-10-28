import type {
  NativeRootOrigin,
  NativeRunExecutionBinding,
} from '@allrice/database';
import type { BoundDeliveryRepair } from '../final-delivery/repair.js';
import type {
  FinalDeliveryPort,
  FinalDeliveryProof,
} from '../final-delivery/guard.js';
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
  AssistantSubscriptionSnapshot,
  NativeQuestionCheckpoint,
  QuestionWait,
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
export interface HarnessInputDeliveryHold {
  settled: Promise<void>;
  current(): boolean;
  resumeBeforeTurnClose(): Promise<void>;
  dispose(): void;
}
export interface HarnessInputDeliveryPort {
  pause(scope: { threadId: string; turnId: string }): HarnessInputDeliveryHold;
}

export interface HarnessExecutionInput {
  /** Current platform rollout switch, shared with Web through PostgreSQL. */
  nativeQuestionMode?: 'legacy' | 'timed';
  /** Owner preference frozen when this Run was enqueued. */
  nativeQuestionWait?: QuestionWait;
  /** Server-loaded current human message before attachment/template augmentation.
   * Selects an existing tool transport only; database admission grants writes. */
  currentUserRequest?: string;
  inputDelivery?: HarnessInputDeliveryPort;
  /**
   * Worker-only, same-Run deterministic delivery check before native finish.
   * Employee jobs must bind this closure; optionality preserves other adapters/callers.
   * Never populated from kernel preferences, browser input or a model tool result.
   */
  finalDelivery?: FinalDeliveryPort;
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
  /** Trusted Worker port; never deserialized from model or browser input. */
  assistants?: {
    rootRunId: string;
    deliveryMode: FinalDeliveryMode;
    deliveryArtifactId?: string;
    /** Trusted controller proof; never populated from browser/model preferences. */
    subscriptionSnapshot?: AssistantSubscriptionSnapshot;
    maxOutputTokens?: number;
    bind(
      nativeSessionId: string,
      generation: number,
      onToolCall?: (call: HarnessToolCall) => Promise<HarnessToolResult>,
      inspect?: (nativeSessionId: string) => Promise<Record<string, unknown>>,
    ): Promise<{
      /** True only for the same persisted root and still-current lease. */
      hasPriorRoot: boolean;
      /** Private native-host lookup; never added to the model tool bridge. */
      readFinalDeliveryReplyOrigin?(): Promise<FinalDeliveryReplyOrigin | null>;
      /** Private same-root facts/policy closure, bound to this native incarnation. */
      finalDelivery?: FinalDeliveryPort;
      /** Private same-incarnation final-text repair; never a model tool. */
      deliveryRepair?: BoundDeliveryRepair;
      handle(
        method: string,
        params: Record<string, unknown>,
      ): Promise<Record<string, unknown>>;
      cancellation(): Promise<{
        nativeSessionId?: string;
        drainDeadlineAt?: string;
        stopReason?: 'cancel' | 'timeout';
        instances: readonly { nativeSessionId: string }[];
      }>;
      cancel(): Promise<void>;
      /** Trusted durable ledger read; never derived from an RPC error payload. */
      failureUsage?(): Promise<{
        usage: HarnessExecutionResult['usage'];
        usageComplete: boolean;
        cacheUsageKnown: boolean;
      }>;
      finish?(delivery?: FinalDeliveryProof): Promise<{
        status: string;
        usage: {
          inputTokens: number;
          cachedInputTokens: number;
          outputTokens: number;
        };
        usageComplete: boolean;
        cacheUsageKnown: boolean;
        costEstimateAvailable: boolean;
        estimatedCostCents?: number | null;
        billingMode?: 'subscription';
        costBasis?: 'conservative_upper_bound' | 'unknown' | 'not_applicable';
        subscriptionSnapshotDigest?: string;
        priceSnapshotDigest?: string;
        costCurrency?: string;
        actualCostKnown?: false;
      }>;
    }>;
  };
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
  waitingForUser?: { questionId: string };
  assistantStatus?: 'completed' | 'partial';
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
    inputKind?: 'steer_current' | 'ask_user';
  }): Promise<void | RuntimeNativeInputProof>;
  compact?(input: { threadId: string }): Promise<void>;
  recover?(input: { threadId: string }): Promise<void>;
  runtimeInventory?(): readonly HarnessRuntimeProcessSnapshot[];
  runtimeClosureInventory?(): readonly HarnessRuntimeClosureSnapshot[];
  /** Idle process close runs only while this returns true. */
  setIdleCloseGate?(gate: () => boolean): void;
  close?(): Promise<void>;
}
import type {
  NativeSessionDescriptor,
  NativeSessionPin,
} from '@allrice/database';
