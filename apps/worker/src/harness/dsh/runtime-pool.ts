import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import {
  harnessContextKey,
  UuidSchema,
  type DshExecutionSnapshot,
  type InternalKernelRequest,
} from '@allrice/contracts';
import type {
  NativeSessionDescriptor,
  NativeSessionPin,
} from '@allrice/database';

import { HandlerError } from '../../errors.js';
import {
  activeCodexSubscriptionHome,
  codexSubscriptionHome,
} from '../../codex-subscription-home.js';
import type {
  HarnessExecutionInput,
  HarnessRuntimeProcessSnapshot,
} from '../adapter.js';
import {
  DeploymentDshCredentialResolver,
  type DshCredentialResolver,
} from '../dsh-credential-resolver.js';
import {
  DSH_DISTRIBUTION_CURRENT_GENERATION,
  DSH_DISTRIBUTION_CURRENT_VERSION,
} from '../dsh-distribution.js';
import { dshEgressEnvironment } from '../dsh-egress-environment.js';
import { DshProtocolClient } from '../dsh-protocol-client.js';
import { checkedDshNativeLaunch } from '../dsh-native-artifact.js';
import {
  dshHostCapabilityInstructions,
  isDshNativeTool,
} from './tool-bridge.js';

export interface DshRuntime {
  client: DshProtocolClient;
  id: string;
  fingerprint: string;
  fingerprintParts: Record<string, string>;
  sessionId: string;
  organizationId: string;
  workspaceId: string;
  productSessionId: string | null;
  internalTask?: InternalKernelRequest['internalTask'];
  ownerId: string;
  providerRoute: string;
  model: string;
  reasoningEffort: string;
  nativeTools: string[];
  startedAt: string;
  lastActivityAt: string;
  nativeArtifactId?: string;
  nativeProfileId?: string;
  nativePin?: NativeSessionPin;
}

export interface DshRuntimePoolOptions {
  credentialResolver?: DshCredentialResolver;
  runtimeCommand?: string;
  runtimeArgs?: readonly string[];
  runtimeRoot?: string;
  cordisConfig?: string;
  requestTimeoutMs?: number;
}

function parseRuntimeArgs(value: string | undefined) {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new HandlerError(
      'DSH_RUNTIME_CONFIG_INVALID',
      'ALLRICE_DSH_RUNTIME_ARGS must be a JSON string array',
      false,
    );
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === 'string')
  ) {
    throw new HandlerError(
      'DSH_RUNTIME_CONFIG_INVALID',
      'ALLRICE_DSH_RUNTIME_ARGS must be a JSON string array',
      false,
    );
  }
  return parsed;
}

function requestTimeout(value: number | undefined) {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1_000 &&
    value <= 3_600_000
    ? value
    : 300_000;
}

function deepseekReasoning(
  effort: DshExecutionSnapshot['reasoningEffort'],
): string {
  if (effort === 'none') return 'off';
  if (effort === 'medium') return 'high';
  if (effort === 'xhigh') return 'max';
  return effort;
}

/** One interpretation of deployment overrides for startup and pool launches. */
export function configuredDshNativeLaunch(options: DshRuntimePoolOptions = {}) {
  const configuredCommand =
    options.runtimeCommand ?? process.env.ALLRICE_DSH_RUNTIME_COMMAND;
  return {
    command: configuredCommand ?? process.execPath,
    args:
      options.runtimeArgs ??
      (process.env.ALLRICE_DSH_RUNTIME_ARGS
        ? parseRuntimeArgs(process.env.ALLRICE_DSH_RUNTIME_ARGS)
        : configuredCommand
          ? []
          : [
              resolve(
                import.meta.dirname,
                '../../../dsh/allrice-jsonrpc-runtime.mjs',
              ),
            ]),
    profile: resolve(
      options.cordisConfig ??
        process.env.ALLRICE_DSH_CORDIS_CONFIG ??
        resolve(
          import.meta.dirname,
          '../../../dsh/allrice-restricted.cordis.yml',
        ),
    ),
  };
}

export class DshRuntimePool {
  private readonly runtimes = new Map<string, DshRuntime>();
  private readonly credentialResolver: DshCredentialResolver;
  private readonly runtimeCommand: string | undefined;
  private readonly runtimeArgs: readonly string[];
  private readonly runtimeRoot: string;
  private readonly cordisConfig: string;
  private readonly requestTimeoutMs: number;

  constructor(options: DshRuntimePoolOptions = {}) {
    this.credentialResolver =
      options.credentialResolver ?? new DeploymentDshCredentialResolver();
    const launch = configuredDshNativeLaunch(options);
    this.runtimeCommand = launch.command;
    this.runtimeArgs = launch.args;
    this.runtimeRoot = resolve(
      options.runtimeRoot ??
        process.env.ALLRICE_DSH_RUNTIME_ROOT ??
        '.local/dsh-runtime',
    );
    this.cordisConfig = launch.profile;
    this.requestTimeoutMs = requestTimeout(
      options.requestTimeoutMs ??
        Number(process.env.ALLRICE_DSH_REQUEST_TIMEOUT_MS ?? 300_000),
    );
  }

  isConfigured(snapshot: HarnessExecutionInput['providerSnapshot']) {
    return snapshot.provider === 'dsh' && Boolean(this.runtimeCommand);
  }

  get(threadId: string) {
    return this.runtimes.get(threadId);
  }

  touch(runtime: DshRuntime) {
    runtime.lastActivityAt = new Date().toISOString();
  }

  /** Pure location calculation, before credentials, mkdir or native launch. */
  private storage(input: HarnessExecutionInput) {
    const organizationId =
      input.executionEnvironment.ALLRICE_ORGANIZATION_ID ?? '';
    const workspaceId = input.executionEnvironment.ALLRICE_WORKSPACE_ID ?? '';
    const ownerId = input.executionEnvironment.ALLRICE_OWNER_ID ?? '';
    if (
      ![organizationId, workspaceId, ownerId].every(
        (value) => UuidSchema.safeParse(value).success,
      )
    )
      throw new HandlerError(
        'DSH_TENANT_CONTEXT_INVALID',
        'DSH execution is missing tenant isolation context',
        false,
      );
    const storageContextKey = harnessContextKey(input.kernel);
    const tenantRoot = resolve(
      this.runtimeRoot,
      organizationId,
      workspaceId,
      ownerId,
      storageContextKey,
    );
    if (!tenantRoot.startsWith(`${this.runtimeRoot}${sep}`))
      throw new HandlerError(
        'DSH_TENANT_CONTEXT_INVALID',
        'DSH runtime path escaped its tenant root',
        false,
      );
    return {
      organizationId,
      workspaceId,
      ownerId,
      storageContextKey,
      tenantRoot,
      storageNamespace: resolve(tenantRoot, 'sessions'),
    };
  }

  describeNativeSession(
    input: HarnessExecutionInput,
    threadId: string,
  ): NativeSessionDescriptor | null {
    const identity = checkedDshNativeLaunch({
      command: this.runtimeCommand ?? '',
      args: this.runtimeArgs,
      profile: this.cordisConfig,
    });
    if (
      input.kernel.runtimeDistributionGeneration !== undefined &&
      input.kernel.runtimeDistributionGeneration !==
        DSH_DISTRIBUTION_CURRENT_GENERATION
    )
      throw new HandlerError(
        'DSH_GENERATION_MISMATCH',
        'The frozen employee package requires a different DSH generation',
        false,
      );
    if (!identity) return null; // Standalone protocol fixture, no approved artifact.
    const storage = this.storage(input);
    return {
      nativeSessionId: threadId,
      artifactId: identity.artifactId,
      artifactManifestDigest: identity.artifactId,
      distributionGeneration: DSH_DISTRIBUTION_CURRENT_GENERATION,
      profileId: identity.profileId as 'restricted' | 'technical',
      storageContextKey: storage.storageContextKey,
      storageNamespace: storage.storageNamespace,
    };
  }

  async acquire(input: {
    input: HarnessExecutionInput;
    snapshot: DshExecutionSnapshot;
    threadId: string;
    systemInstructions: string;
    nativeSkills: NonNullable<HarnessExecutionInput['nativeSkills']>;
    nativePin?: NativeSessionPin;
  }) {
    const acquireStarted = performance.now();
    let nativeIdentity: ReturnType<typeof checkedDshNativeLaunch>;
    try {
      nativeIdentity = checkedDshNativeLaunch({
        command: this.runtimeCommand ?? '',
        args: this.runtimeArgs,
        profile: this.cordisConfig,
      });
    } catch (error) {
      const code =
        error instanceof Error &&
        /^DSH_NATIVE_ARTIFACT_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'DSH_NATIVE_ARTIFACT_UNAVAILABLE';
      throw new HandlerError(
        code,
        '当前执行环境暂不可用，请联系平台维护。',
        false,
      );
    }
    const frozenGeneration = input.input.kernel.runtimeDistributionGeneration;
    if (
      frozenGeneration !== undefined &&
      frozenGeneration !== DSH_DISTRIBUTION_CURRENT_GENERATION
    ) {
      throw new HandlerError(
        'DSH_GENERATION_MISMATCH',
        'The frozen employee package requires a different DSH generation; finish its Run on the original Worker before migrating',
        false,
      );
    }
    if (input.snapshot.route === 'gemini') {
      throw new HandlerError(
        'GEMINI_API_DISABLED',
        'Gemini API execution is disabled; historical sessions remain readable',
        false,
      );
    }
    if (!this.runtimeCommand) {
      throw new HandlerError(
        'DSH_RUNTIME_UNAVAILABLE',
        'DSH is not configured in this deployment',
        false,
      );
    }

    const { organizationId, workspaceId, ownerId, tenantRoot } = this.storage(
      input.input,
    );
    const descriptor = this.describeNativeSession(input.input, input.threadId);
    if (descriptor) {
      if (!input.nativePin)
        throw new HandlerError(
          'DSH_NATIVE_SESSION_BINDING_REQUIRED',
          '原生会话尚未获得当前任务授权。',
          false,
        );
      if (
        Object.entries(descriptor).some(
          ([k, v]) => input.nativePin![k as keyof NativeSessionPin] !== v,
        ) ||
        input.nativePin.organizationId !== organizationId ||
        input.nativePin.workspaceId !== workspaceId ||
        input.nativePin.ownerId !== ownerId
      )
        throw new HandlerError(
          'DSH_NATIVE_SESSION_BINDING_CONFLICT',
          '原生会话的制品或存储身份不一致。',
          false,
        );
    }
    const resident = this.runtimes.get(input.threadId);
    if (
      resident &&
      (resident.organizationId !== organizationId ||
        resident.workspaceId !== workspaceId ||
        resident.ownerId !== ownerId ||
        resident.productSessionId !== input.input.kernel.sessionId ||
        JSON.stringify(resident.internalTask ?? null) !==
          JSON.stringify(
            'internalTask' in input.input.kernel
              ? input.input.kernel.internalTask
              : null,
          ) ||
        (input.nativePin &&
          JSON.stringify(resident.nativePin) !==
            JSON.stringify(input.nativePin)))
    )
      throw new HandlerError(
        'DSH_NATIVE_SESSION_BINDING_CONFLICT',
        '原生会话不能替换其他运行身份。',
        false,
      );
    const credentialStarted = performance.now();
    const dshPlatformHome =
      input.snapshot.route === 'openai-codex'
        ? await activeCodexSubscriptionHome()
        : codexSubscriptionHome(1);
    const dshCredentialsPath = resolve(dshPlatformHome, '.credentials.yaml');
    const credential =
      input.snapshot.route === 'openai-codex'
        ? null
        : await this.credentialResolver.resolve({
            reference: input.snapshot.credentialReference,
            organizationId,
            workspaceId,
            ownerId,
            route: input.snapshot.route,
          });
    // DSH owns credential parsing, watching and OAuth refresh. A no-op atomic
    // rewrite changes file metadata without changing its grant. Conversely,
    // replacing a grant can preserve size/mtime. Use the document bytes only
    // for invalidation; never retain or emit the document or its digest.
    const codexGrantDigest =
      input.snapshot.route === 'openai-codex'
        ? await readFile(dshCredentialsPath)
            .then((bytes) => createHash('sha256').update(bytes).digest('hex'))
            .catch(() => null)
        : null;
    if (input.snapshot.route === 'openai-codex' && !codexGrantDigest) {
      throw new HandlerError(
        'CODEX_SUBSCRIPTION_AUTH_REQUIRED',
        'The platform Codex subscription must be authorized before DSH can use it',
        false,
      );
    }
    const credentialResolutionMs = performance.now() - credentialStarted;
    const maxTokens =
      input.input.assistants?.maxOutputTokens ??
      input.input.maxOutputTokens ??
      (input.input.assistants ? 16_000 : undefined);
    // Store only per-field hashes in memory so diagnostics can name changed
    // configuration without recording its values.
    const fingerprintInput = {
      ...(nativeIdentity ? { nativeArtifact: nativeIdentity } : {}),
      ...(input.nativePin ? { nativeSessionBinding: input.nativePin } : {}),
      snapshot: input.snapshot,
      codexSubscriptionHome: dshPlatformHome,
      runtimePackageChecksum: input.input.kernel.runtimePackageChecksum,
      ...(input.input.baseSkillCatalog
        ? {
            baseSkillCatalogChecksum:
              input.input.baseSkillCatalog.snapshotChecksum,
          }
        : {}),
      systemInstructions: input.systemInstructions,
      taskProgress: !!input.input.progress,
      contentGuard: !!input.input.contentGuard,
      ...(input.input.contentGuard?.nativeContextKey &&
      input.input.contentGuard.nativeContextKey !==
        input.input.contentGuard.generationId
        ? {
            contentScenes: input.input.contentGuard.scenes,
            nativeContentContext: input.input.contentGuard.nativeContextKey,
          }
        : {}),
      durableQuestions: !!input.input.questionWait,
      // Run authority is rebound by the adapter and released by finish.
      // Only process configuration belongs in the session reuse key.
      assistantsEnabled: !!input.input.assistants,
      maxTokens,
      nativeTools: input.input.tools
        .map((tool) => tool.name)
        .filter(isDshNativeTool)
        .sort(),
      nativeSkills: input.nativeSkills.map((skill) => ({
        id: skill.id,
        checksum: skill.checksum,
        name: skill.name,
        invocation: skill.invocation,
        ...(skill.bundle ? { bundleChecksum: skill.bundle.checksum } : {}),
        ...(skill.personal
          ? {
              personal: skill.personal,
              whenToUse: skill.whenToUse,
              metadata: skill.metadata,
            }
          : {}),
      })),
      credentialDigest: credential
        ? createHash('sha256').update(credential.apiKey).digest('hex')
        : `codex-grant:${codexGrantDigest}`,
    };
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(fingerprintInput))
      .digest('hex');
    const fingerprintParts = Object.fromEntries(
      Object.entries(fingerprintInput).map(([key, value]) => [
        key,
        createHash('sha256')
          .update(JSON.stringify(value) ?? 'undefined')
          .digest('hex'),
      ]),
    );
    const existing = this.runtimes.get(input.threadId);
    const preparation = {
      cache: existing?.fingerprint === fingerprint ? 'hit' : 'miss',
      reason: existing
        ? existing.fingerprint === fingerprint
          ? 'reused'
          : 'configuration_changed'
        : 'not_resident',
      changedFields: existing
        ? [
            ...new Set([
              ...Object.keys(existing.fingerprintParts),
              ...Object.keys(fingerprintParts),
            ]),
          ].filter(
            (key) => existing.fingerprintParts[key] !== fingerprintParts[key],
          )
        : [],
      credentialResolutionMs,
      previousRuntimeCloseMs: 0,
      initializeMs: 0,
      // Null means unmeasured (e.g. an older host), zero means no registration
      // was needed on this acquisition. These are not Skill body load times.
      skillRegistrationMs:
        existing?.fingerprint === fingerprint ? 0 : (null as number | null),
      acquireMs: 0,
    };
    if (existing?.fingerprint === fingerprint) {
      if (
        nativeIdentity &&
        (existing.nativeArtifactId !== nativeIdentity.artifactId ||
          existing.nativeProfileId !== nativeIdentity.profileId)
      )
        throw new HandlerError(
          'DSH_NATIVE_ARTIFACT_CACHE_MISMATCH',
          '当前执行环境暂不可用，请联系平台维护。',
          false,
        );
      preparation.acquireMs = performance.now() - acquireStarted;
      return { runtime: existing, fresh: false, preparation };
    }
    if (existing) {
      const closeStarted = performance.now();
      await this.drop(input.threadId);
      preparation.previousRuntimeCloseMs = performance.now() - closeStarted;
    }
    await mkdir(tenantRoot, { recursive: true, mode: 0o700 });
    await mkdir(dshPlatformHome, { recursive: true, mode: 0o700 });
    const environment: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LANG: process.env.LANG ?? 'C.UTF-8',
      ...dshEgressEnvironment(),
      DSH_CORDIS_CONFIG: this.cordisConfig,
      DSH_HOME: dshPlatformHome,
      DSH_RUNTIME_HOME: tenantRoot,
      DSH_CREDENTIALS_PATH: resolve(dshPlatformHome, '.credentials.yaml'),
      DSH_CWD: tenantRoot,
      DSH_SESSION_ROOT: resolve(tenantRoot, 'sessions'),
      DSH_MODEL: input.snapshot.model,
      DSH_CODEX_MODEL:
        input.snapshot.route === 'openai-codex'
          ? input.snapshot.model
          : 'gpt-6.1-sol',
      DSH_OPENAI_COMPATIBLE_MODEL:
        input.snapshot.route === 'openai-compatible'
          ? input.snapshot.model
          : 'allrice-unused',
      // DeepSeek's off/high/max vocabulary is not the pi-ai vocabulary.
      DSH_REASONING_EFFORT: deepseekReasoning(input.snapshot.reasoningEffort),
      DSH_CODEX_REASONING_EFFORT:
        input.snapshot.route === 'openai-codex'
          ? input.snapshot.reasoningEffort === 'none'
            ? 'off'
            : input.snapshot.reasoningEffort
          : 'high',
      DSH_SYSTEM_PROMPT: [
        input.systemInstructions,
        dshHostCapabilityInstructions(input.input.tools),
      ].join('\n\n'),
      DSH_DISTRIBUTION_VERSION: DSH_DISTRIBUTION_CURRENT_VERSION,
      DSH_MAX_OUTPUT_TOKENS: String(maxTokens ?? 16_000),
      ...(input.input.assistants ? { ALLRICE_ASSISTANTS_ENABLED: '1' } : {}),
      ...(input.input.progress ? { ALLRICE_PROGRESS_GUARD_ENABLED: '1' } : {}),
      ...(input.input.progress &&
      input.input.executionEnvironment.ALLRICE_MAINTENANCE_OUTPUT_TOKENS
        ? {
            ALLRICE_MAINTENANCE_OUTPUT_TOKENS:
              input.input.executionEnvironment
                .ALLRICE_MAINTENANCE_OUTPUT_TOKENS,
          }
        : {}),
    };
    if (input.snapshot.route === 'openai-codex') {
      // The DSH credential service resolves and refreshes the platform OAuth
      // grant. No token is copied into the child environment.
    } else if (input.snapshot.route === 'deepseek-official') {
      environment.DEEPSEEK_API_KEY = credential!.apiKey;
      if (input.snapshot.baseUrl) {
        environment.DEEPSEEK_BASE_URL = input.snapshot.baseUrl;
      }
    } else {
      environment.OPENAI_COMPATIBLE_API_KEY = credential!.apiKey;
      environment.OPENAI_COMPATIBLE_BASE_URL = input.snapshot.baseUrl!;
    }
    const nativeTools = input.input.tools
      .map((tool) => tool.name)
      .filter(isDshNativeTool);
    const startedAt = new Date().toISOString();
    const runtime: DshRuntime = {
      ...(input.nativePin ? { nativePin: input.nativePin } : {}),
      ...(nativeIdentity
        ? {
            nativeArtifactId: nativeIdentity.artifactId,
            nativeProfileId: nativeIdentity.profileId,
          }
        : {}),
      client: new DshProtocolClient({
        command: this.runtimeCommand,
        args: this.runtimeArgs,
        cwd: tenantRoot,
        environment,
        requestTimeoutMs: this.requestTimeoutMs,
      }),
      id: randomUUID(),
      fingerprint,
      fingerprintParts,
      sessionId: input.threadId,
      organizationId,
      workspaceId,
      productSessionId: input.input.kernel.sessionId,
      ...('internalTask' in input.input.kernel
        ? { internalTask: input.input.kernel.internalTask }
        : {}),
      ownerId,
      providerRoute: input.snapshot.route,
      model: input.snapshot.model,
      reasoningEffort: input.snapshot.reasoningEffort,
      nativeTools,
      startedAt,
      lastActivityAt: startedAt,
    };
    try {
      const initializeStarted = performance.now();
      const initialized = await runtime.client.initialize({
        cwd: tenantRoot,
        provider: input.snapshot.route,
        model: input.snapshot.model,
        nativeTools,
        nativeSkills: input.nativeSkills,
        contentScenes: input.input.contentGuard?.scenes,
        maxTokens,
        expectedVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
        requireTaskProgress: !!input.input.progress,
        requireDurableQuestions: !!input.input.questionWait,
        requireContentGuard: !!input.input.contentGuard,
      });
      preparation.initializeMs = performance.now() - initializeStarted;
      preparation.skillRegistrationMs = initialized.skillRegistrationMs;
      preparation.acquireMs = performance.now() - acquireStarted;
      this.runtimes.set(input.threadId, runtime);
      return { runtime, fresh: true, preparation };
    } catch (error) {
      await runtime.client.close();
      throw error;
    }
  }

  async interrupt(threadId: string) {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return;
    await runtime.client.interrupt(runtime.sessionId);
  }

  async compact(threadId: string) {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return;
    await runtime.client.compact(runtime.sessionId);
  }

  async recover(threadId: string) {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return;
    await runtime.client.recover(runtime.sessionId);
  }

  async steer(
    threadId: string,
    message: string,
    typed?: {
      inputId: string;
      turnId: string;
      kind: 'steer_current' | 'ask_user';
    },
  ) {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) {
      throw new HandlerError(
        'DSH_SESSION_NOT_LIVE',
        'DSH session is not live on this worker',
        true,
      );
    }
    return runtime.client.steer(runtime.sessionId, message, typed);
  }

  inventory(): readonly HarnessRuntimeProcessSnapshot[] {
    return [...this.runtimes.values()].map((runtime) => ({
      id: runtime.id,
      organizationId: runtime.organizationId,
      workspaceId: runtime.workspaceId,
      sessionId: runtime.productSessionId,
      ...(runtime.internalTask ? { internalTask: runtime.internalTask } : {}),
      ownerId: runtime.ownerId,
      threadId: runtime.sessionId,
      providerRoute: runtime.providerRoute,
      model: runtime.model,
      reasoningEffort: runtime.reasoningEffort,
      profileFingerprint: runtime.fingerprint,
      nativeTools: [...runtime.nativeTools],
      startedAt: runtime.startedAt,
      lastActivityAt: runtime.lastActivityAt,
    }));
  }

  async drop(threadId: string) {
    const runtime = this.runtimes.get(threadId);
    this.runtimes.delete(threadId);
    await runtime?.client.close();
  }

  async close() {
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.allSettled(runtimes.map((runtime) => runtime.client.close()));
  }
}
