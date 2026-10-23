import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, sep, dirname } from 'node:path';

import {
  harnessContextKey,
  UuidSchema,
  DSH_FROZEN_PROFILE_GENERATIONS,
  type DshExecutionSnapshot,
  type InternalKernelRequest,
} from '@allrice/contracts';
import type {
  NativeSessionDescriptor,
  NativeRootOrigin,
  NativeSessionPin,
  EmployeeRunExecutionBinding,
} from '@allrice/database';
import {
  EmployeeRunExecutionBindingSchema,
  nativeRootDigest,
} from '@allrice/database';

import { HandlerError } from '../../errors.js';
import {
  activeCodexSubscriptionHome,
  codexSubscriptionHome,
} from '../../codex-subscription-home.js';
import type {
  HarnessExecutionInput,
  HarnessRuntimeProcessSnapshot,
  HarnessInputDeliveryHold,
  HarnessInputDeliveryPort,
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
import { assertStoredNativeSession } from '../dsh-native-storage.js';
import {
  assertVirginNativeNamespace,
  NativeOriginStorageError,
} from '../native-origin-storage.js';
import {
  checkedDshNativeLaunch,
  nativeArtifactLaunchForPin,
} from '../dsh-native-artifact.js';
import {
  legacyDshNativeLaunch,
  originDshNativeLaunch,
  pinnedDshNativeLaunch,
  employeePreviewStorageRoot,
  retainedDshStorageRoot,
  assertDshFrozenCompatibility,
} from '../dsh-native-retention.js';
import { dshHostCapabilityInstructions } from './tool-bridge.js';
import { selectDshNativeTools } from './native-tools.js';

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
  private readonly inputSteers = new Map<DshRuntime, Set<Promise<boolean>>>();
  private readonly inputHolds = new Map<
    DshRuntime,
    {
      gateId: string;
      turnId: string;
      runId: string;
      phase: 'paused' | 'releasing' | 'released';
      hold: HarnessInputDeliveryHold;
      paused: Promise<Record<string, unknown>>;
      released?: Promise<Record<string, unknown>>;
    }
  >();
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

  /** Offline protocol fixtures have no approved artifact or SQL authority.
   * Every production Worker installs and validates its artifact before producers. */
  hasApprovedNativeLaunch() {
    return !!checkedDshNativeLaunch({
      command: this.runtimeCommand ?? '',
      args: this.runtimeArgs,
      profile: this.cordisConfig,
    });
  }

  /** Pure location calculation, before credentials, mkdir or native launch. */
  private storage(
    input: HarnessExecutionInput,
    pin?: NativeSessionPin,
    artifactId?: string,
    originStorageNamespace?: string,
  ) {
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
    const storageRoot =
      (artifactId && retainedDshStorageRoot(artifactId)) || this.runtimeRoot;
    const expectedNamespace =
      originStorageNamespace ??
      resolve(
        storageRoot,
        organizationId,
        workspaceId,
        ownerId,
        storageContextKey,
        'sessions',
      );
    if (
      (originStorageNamespace &&
        !expectedNamespace.endsWith(
          `/${organizationId}/${workspaceId}/${ownerId}/${storageContextKey}/sessions`,
        )) ||
      (!originStorageNamespace &&
        !expectedNamespace.startsWith(`${storageRoot}${sep}`))
    )
      throw new HandlerError(
        'DSH_TENANT_CONTEXT_INVALID',
        'DSH runtime path escaped its tenant root',
        false,
      );
    if (
      pin &&
      ((pin.storageNamespace !== expectedNamespace &&
        !(
          pin.contextKind === 'platform_employee_test' &&
          pin.contextId === storageContextKey &&
          pin.storageNamespace ===
            resolve(
              employeePreviewStorageRoot(),
              storageContextKey,
              organizationId,
              workspaceId,
              ownerId,
              storageContextKey,
              'sessions',
            )
        )) ||
        pin.storageContextKey !== storageContextKey ||
        pin.organizationId !== organizationId ||
        pin.workspaceId !== workspaceId ||
        pin.ownerId !== ownerId)
    )
      throw new HandlerError(
        'DSH_NATIVE_SESSION_BINDING_CONFLICT',
        '原生会话的数据位置与已登记的范围不一致。',
        false,
      );
    const storageNamespace = pin?.storageNamespace ?? expectedNamespace;
    return {
      organizationId,
      workspaceId,
      ownerId,
      storageContextKey,
      tenantRoot: dirname(storageNamespace),
      storageNamespace,
    };
  }

  private launch(
    input: HarnessExecutionInput,
    pin?: NativeSessionPin,
    origin?: NativeRootOrigin | null,
    executionBinding?: EmployeeRunExecutionBinding | null,
  ) {
    const currentBinding =
      executionBinding == null
        ? null
        : EmployeeRunExecutionBindingSchema.parse(executionBinding);
    // This fact only comes from the leased SQL prepare closure. Validate its
    // exact caller and original source before translating to the approved
    // executor; never alter the source kernel or infer approval from a pin.
    if ((origin?.schemaVersion === 2) !== !!currentBinding)
      throw Error('DSH_NATIVE_ARTIFACT_EXECUTION_BINDING_REQUIRED');
    if (
      currentBinding &&
      (!origin ||
        origin.schemaVersion !== 2 ||
        currentBinding.originDigest !== nativeRootDigest(origin) ||
        currentBinding.scope.runId !==
          input.executionEnvironment.ALLRICE_RUN_ID ||
        currentBinding.scope.organizationId !==
          input.executionEnvironment.ALLRICE_ORGANIZATION_ID ||
        currentBinding.scope.workspaceId !==
          input.executionEnvironment.ALLRICE_WORKSPACE_ID ||
        currentBinding.scope.ownerId !==
          input.executionEnvironment.ALLRICE_OWNER_ID ||
        currentBinding.scope.sessionId !== input.kernel.sessionId ||
        currentBinding.source.employeeVersionId !==
          input.kernel.employeeVersionId ||
        (currentBinding.source.packageChecksum ?? undefined) !==
          input.kernel.runtimePackageChecksum ||
        (currentBinding.source.declaredGeneration ?? undefined) !==
          input.kernel.runtimeDistributionGeneration ||
        currentBinding.execution.artifactId !== origin.artifactId ||
        currentBinding.execution.generation !== origin.distributionGeneration ||
        currentBinding.execution.profileId !== origin.profileId ||
        (pin &&
          (pin.bindingBasis !== 'business_root_origin' ||
            pin.rootOriginDigest !== currentBinding.originDigest)))
    )
      throw Error('DSH_NATIVE_ARTIFACT_EXECUTION_BINDING_MISMATCH');
    // Even a pin cannot turn a deployment/constructor override into approval.
    const identity = checkedDshNativeLaunch({
      command: this.runtimeCommand ?? '',
      args: this.runtimeArgs,
      profile: this.cordisConfig,
    });
    if (!identity) {
      if (currentBinding)
        throw Error('DSH_NATIVE_ARTIFACT_CURRENT_EXECUTOR_UNAPPROVED');
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
      return null;
    }
    const profileId = identity.profileId as 'restricted' | 'technical';
    if (pin && pin.profileId !== profileId)
      throw new HandlerError(
        'DSH_NATIVE_SESSION_BINDING_CONFLICT',
        '原生会话的执行配置与已登记的范围不一致。',
        false,
      );
    const fallback = nativeArtifactLaunchForPin({
      artifactId: identity.artifactId,
      profileId,
    });
    const selected: ReturnType<typeof originDshNativeLaunch> = pin
      ? pinnedDshNativeLaunch(pin)
      : origin
        ? originDshNativeLaunch(origin, profileId, {
            organizationId:
              input.executionEnvironment.ALLRICE_ORGANIZATION_ID ?? '',
            workspaceId: input.executionEnvironment.ALLRICE_WORKSPACE_ID ?? '',
            ownerId: input.executionEnvironment.ALLRICE_OWNER_ID ?? '',
          })
        : legacyDshNativeLaunch(fallback, profileId);
    if (origin && origin.rootSeed !== harnessContextKey(input.kernel))
      throw Error('DSH_NATIVE_ARTIFACT_NEW_ROOT_FROZEN_IDENTITY');
    // Birth package provenance is checked by SQL against the original immutable
    // publication. A later same-generation Run may carry an updated package;
    // its own checksum is verified by the normal frozen Run binding below.
    checkedDshNativeLaunch(selected);
    if (
      currentBinding &&
      (selected.artifactId !== currentBinding.execution.artifactId ||
        selected.generation !== currentBinding.execution.generation ||
        profileId !== currentBinding.execution.profileId)
    )
      throw Error('DSH_NATIVE_ARTIFACT_EXECUTION_BINDING_MISMATCH');
    assertDshFrozenCompatibility(
      currentBinding?.execution.generation ??
        input.kernel.runtimeDistributionGeneration ??
        (origin?.schemaVersion === 1 &&
        origin.frozenIdentity.kind === 'internal_recipe'
          ? origin.distributionGeneration
          : pin?.bindingBasis === 'business_root_origin' &&
              ('internalTask' in input.kernel || profileId === 'technical')
            ? pin.distributionGeneration
            : undefined),
      selected,
      profileId,
    );
    return { ...selected, profileId };
  }

  describeNativeSession(
    input: HarnessExecutionInput,
    threadId: string,
    pin?: NativeSessionPin,
    origin?: NativeRootOrigin | null,
    executionBinding?: EmployeeRunExecutionBinding | null,
  ): NativeSessionDescriptor | null {
    const identity = this.launch(input, pin, origin, executionBinding);
    if (!identity) return null; // Standalone fixture, no approved artifact.
    const generation = DSH_FROZEN_PROFILE_GENERATIONS.find(
      (value) => value === identity.generation,
    );
    if (!generation)
      throw new HandlerError(
        'DSH_GENERATION_MISMATCH',
        '当前原生会话版本尚未获得执行批准。',
        false,
      );
    if (
      pin &&
      (pin.nativeSessionId !== threadId ||
        pin.distributionGeneration !== generation)
    )
      throw new HandlerError(
        'DSH_NATIVE_SESSION_BINDING_CONFLICT',
        '原生会话的版本与绑定不一致。',
        false,
      );
    const storage = this.storage(
      input,
      pin,
      identity.artifactId,
      identity.originStorageNamespace,
    );
    return {
      nativeSessionId: threadId,
      artifactId: identity.artifactId,
      artifactManifestDigest: identity.artifactId,
      distributionGeneration: generation,
      profileId: identity.profileId,
      storageContextKey: storage.storageContextKey,
      storageNamespace: storage.storageNamespace,
      ...(identity.originReaderApprovalDigest
        ? { originReaderApprovalDigest: identity.originReaderApprovalDigest }
        : {}),
    };
  }

  /** Only for the first writer of a previously unbound, explicitly approved
   * origin. The caller owns a live Job and the deployment has fenced old
   * producers. Later adopted writers recover normally through the public SDK. */
  async assertOriginReaderFirstWriter(
    input: HarnessExecutionInput,
    threadId: string,
    origin: NativeRootOrigin,
  ) {
    const descriptor = this.describeNativeSession(
      input,
      threadId,
      undefined,
      origin,
    );
    if (!descriptor?.originReaderApprovalDigest)
      throw Error('DSH_NATIVE_ORIGIN_READER_APPROVAL_REQUIRED');
    try {
      await assertVirginNativeNamespace(
        descriptor.storageNamespace,
        input.signal,
      );
    } catch (error) {
      if (!(error instanceof NativeOriginStorageError)) throw error;
      throw new HandlerError(
        error.code,
        '原会话的首次执行条件未确认，已保留原始记录。',
        false,
      );
    }
  }

  /** Read-only native metadata check. No SQL locks, credentials, writer or
   * replacement directories; use the exact selected artifact's public backend. */
  async assertStoredSession(
    input: HarnessExecutionInput,
    threadId: string,
    pin?: NativeSessionPin,
    origin?: NativeRootOrigin | null,
    executionBinding?: EmployeeRunExecutionBinding | null,
  ) {
    const launch = this.launch(input, pin, origin, executionBinding);
    const descriptor = this.describeNativeSession(
      input,
      threadId,
      pin,
      origin,
      executionBinding,
    );
    if (launch && descriptor)
      await assertStoredNativeSession(
        launch.args[0]!,
        descriptor,
        input.signal,
      );
  }

  async acquire(input: {
    input: HarnessExecutionInput;
    snapshot: DshExecutionSnapshot;
    threadId: string;
    systemInstructions: string;
    nativeSkills: NonNullable<HarnessExecutionInput['nativeSkills']>;
    nativePin?: NativeSessionPin;
    nativeOrigin?: NativeRootOrigin | null;
    nativeExecutionBinding?: EmployeeRunExecutionBinding | null;
    requireRecovery?: boolean;
  }) {
    const acquireStarted = performance.now();
    let nativeIdentity: ReturnType<DshRuntimePool['launch']>;
    try {
      nativeIdentity = this.launch(
        input.input,
        input.nativePin,
        input.nativeOrigin,
        input.nativeExecutionBinding,
      );
    } catch (error) {
      if (error instanceof HandlerError) throw error;
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
      input.nativePin,
      nativeIdentity?.artifactId,
      nativeIdentity?.originStorageNamespace,
    );
    const descriptor = this.describeNativeSession(
      input.input,
      input.threadId,
      input.nativePin,
      input.nativeOrigin,
      input.nativeExecutionBinding,
    );
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
    if (descriptor && input.requireRecovery)
      await this.assertStoredSession(
        input.input,
        input.threadId,
        input.nativePin,
        input.nativeOrigin,
        input.nativeExecutionBinding,
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
    const nativeTools = await selectDshNativeTools(
      input.input.tools.map((tool) => tool.name),
      nativeIdentity?.args[0],
    );
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
      nativeTools: [...nativeTools].sort(),
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
      DSH_CORDIS_CONFIG: nativeIdentity?.profile ?? this.cordisConfig,
      DSH_HOME: dshPlatformHome,
      DSH_RUNTIME_HOME: tenantRoot,
      DSH_CREDENTIALS_PATH: resolve(dshPlatformHome, '.credentials.yaml'),
      DSH_CWD: tenantRoot,
      DSH_SESSION_ROOT:
        descriptor?.storageNamespace ?? resolve(tenantRoot, 'sessions'),
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
      DSH_DISTRIBUTION_VERSION:
        nativeIdentity?.version ?? DSH_DISTRIBUTION_CURRENT_VERSION,
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
        command: nativeIdentity?.command ?? this.runtimeCommand,
        args: nativeIdentity?.args ?? this.runtimeArgs,
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
        expectedVersion:
          nativeIdentity?.version ?? DSH_DISTRIBUTION_CURRENT_VERSION,
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
    originalTurnId?: string,
  ) {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) {
      throw new HandlerError(
        'DSH_SESSION_NOT_LIVE',
        'DSH session is not live on this worker',
        true,
      );
    }
    const held = this.inputHolds.get(runtime);
    if (
      held?.phase === 'paused' &&
      held.turnId === (originalTurnId ?? typed?.turnId)
    )
      throw new HandlerError(
        'ASSISTANT_COMPLETING',
        'ASSISTANT_COMPLETING',
        false,
      );
    const work = runtime.client.steer(runtime.sessionId, message, typed);
    const outcome = work.then(
      () => false,
      (error: unknown) =>
        error instanceof HandlerError && error.code === 'ASSISTANT_COMPLETING',
    );
    const active = this.inputSteers.get(runtime) ?? new Set<Promise<boolean>>();
    this.inputSteers.set(runtime, active);
    active.add(outcome);
    void outcome.then(() => {
      active.delete(outcome);
      if (!active.size && this.inputSteers.get(runtime) === active)
        this.inputSteers.delete(runtime);
    });
    return work;
  }

  /** Native/Worker private handshake. ACK means drained control state, never adopted input. */
  async inputDeliveryControl(
    runtime: DshRuntime,
    operation: 'pause' | 'release',
    params: Record<string, unknown>,
    context: {
      runId: string;
      turnId(): string | null;
      signal: AbortSignal;
      delivery: HarnessInputDeliveryPort;
      assertAuthority(): Promise<void>;
    },
  ) {
    const gateId = UuidSchema.parse(params.gateId);
    if (
      this.runtimes.get(runtime.sessionId) !== runtime ||
      params.nativeSessionId !== runtime.sessionId ||
      params.runId !== context.runId ||
      typeof params.turnId !== 'string'
    )
      throw new HandlerError(
        'INPUT_GATE_SCOPE_CHANGED',
        'INPUT_GATE_SCOPE_CHANGED',
        false,
      );
    const prior = this.inputHolds.get(runtime);
    if (operation === 'release') {
      if (
        !prior ||
        prior.gateId !== gateId ||
        prior.turnId !== params.turnId ||
        prior.runId !== context.runId
      )
        throw new HandlerError(
          'INPUT_GATE_SCOPE_CHANGED',
          'INPUT_GATE_SCOPE_CHANGED',
          false,
        );
      return (prior.released ??= (async () => {
        prior.phase = 'releasing'; // allow the existing poller's real handoff RPCs
        try {
          await prior.hold.resumeBeforeTurnClose();
          await context.assertAuthority();
          context.signal.throwIfAborted();
          if (context.turnId() !== prior.turnId)
            throw new HandlerError(
              'INPUT_GATE_SCOPE_CHANGED',
              'INPUT_GATE_SCOPE_CHANGED',
              false,
            );
          return { released: true, gateId, turnId: prior.turnId };
        } finally {
          prior.phase = 'released';
          prior.hold.dispose();
        }
      })());
    }
    context.signal.throwIfAborted();
    if (context.turnId() !== params.turnId)
      throw new HandlerError(
        'INPUT_GATE_SCOPE_CHANGED',
        'INPUT_GATE_SCOPE_CHANGED',
        false,
      );
    if (prior?.gateId === gateId) {
      if (prior.phase !== 'paused')
        throw new HandlerError(
          'INPUT_GATE_RELEASED',
          'INPUT_GATE_RELEASED',
          false,
        );
      return prior.paused;
    }
    if (prior && prior.phase !== 'released')
      throw new HandlerError('INPUT_GATE_BUSY', 'INPUT_GATE_BUSY', false);
    const hold = context.delivery.pause({
      threadId: runtime.sessionId,
      turnId: params.turnId,
    });
    const inFlight = [...(this.inputSteers.get(runtime) ?? [])];
    const state = {
      gateId,
      turnId: params.turnId,
      runId: context.runId,
      phase: 'paused' as 'paused' | 'releasing' | 'released',
      hold,
      paused: Promise.resolve({}) as Promise<Record<string, unknown>>,
    };
    this.inputHolds.set(runtime, state);
    state.paused = (async () => {
      const outcomes = (
        await Promise.all([hold.settled, Promise.all(inFlight)])
      )[1];
      if (outcomes.some((knownRefusal) => !knownRefusal) || !hold.current())
        throw new HandlerError(
          'INPUT_GATE_NOT_QUIESCENT',
          'INPUT_GATE_NOT_QUIESCENT',
          false,
        );
      await context.assertAuthority();
      context.signal.throwIfAborted();
      if (!hold.current() || context.turnId() !== state.turnId)
        throw new HandlerError(
          'INPUT_GATE_SCOPE_CHANGED',
          'INPUT_GATE_SCOPE_CHANGED',
          false,
        );
      return { paused: true, gateId, turnId: state.turnId };
    })();
    return state.paused;
  }

  clearInputDelivery(runtime: DshRuntime) {
    this.inputHolds.get(runtime)?.hold.dispose();
    this.inputHolds.delete(runtime);
    // A prior caller may have returned while its RPC is still unresolved.
    if (!this.inputSteers.get(runtime)?.size) this.inputSteers.delete(runtime);
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
    if (runtime) this.clearInputDelivery(runtime);
    await runtime?.client.close();
  }

  /** An execution owns this object, even after another caller cleared the
   * pool or installed a new same-key runtime. Map absence is not a close ACK.
   * Wait the original client's real close promise and leave replacements alone. */
  async closeOwned(runtime: DshRuntime) {
    if (this.runtimes.get(runtime.sessionId) === runtime)
      this.runtimes.delete(runtime.sessionId);
    this.clearInputDelivery(runtime);
    await runtime.client.close();
  }

  async close() {
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    for (const runtime of runtimes) this.clearInputDelivery(runtime);
    await Promise.allSettled(runtimes.map((runtime) => runtime.client.close()));
  }
}
