import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HarnessExecutionInput } from '../adapter.js';
import * as CodexSubscription from '../../codex-subscription-home.js';
import * as NativeArtifact from '../dsh-native-artifact.js';
import * as NativeRetention from '../dsh-native-retention.js';
import * as NativeStorage from '../dsh-native-storage.js';
import {
  DSH_MISSING_FROZEN_GENERATION,
  PlatformEmployeeDefinitionSchema,
} from '@allrice/contracts';
import {
  employeeManifest,
  employeeManifestChecksum,
} from '../../../../../packages/database/src/employees/employee-config.ts';
import {
  buildEmployeeRuntimePackage,
  runtimePackageChecksum,
} from '../../../../../packages/database/src/platform-employees/runtime-package.ts';
import {
  EmployeeRunExecutionBindingSchema,
  nativeRootDigest,
  newCurrentEmployeeChatOrigin,
  validateEmployeeExecutionSource,
} from '../../../../../packages/database/src/conversation/current-execution-binding.ts';
import {
  skillBundleChecksum,
  skillBytesChecksum,
} from '../../../../../packages/database/src/skill-bundles.ts';
import {
  DshRuntimePool,
  configuredDshNativeLaunch,
  type DshRuntime,
} from './runtime-pool.js';

let root: string;
const pools: DshRuntimePool[] = [];

it('uses identical deployment defaults for startup and runtime construction', () => {
  expect(configuredDshNativeLaunch()).toEqual({
    command: process.execPath,
    args: [
      resolve(import.meta.dirname, '../../../dsh/allrice-jsonrpc-runtime.mjs'),
    ],
    profile: resolve(
      import.meta.dirname,
      '../../../dsh/allrice-restricted.cordis.yml',
    ),
  });
});

it('retains explicit constructor precedence over parsed deployment overrides', () => {
  vi.stubEnv('ALLRICE_DSH_RUNTIME_COMMAND', '/deployment/node');
  vi.stubEnv('ALLRICE_DSH_RUNTIME_ARGS', '["/deployment/entry.mjs"]');
  vi.stubEnv('ALLRICE_DSH_CORDIS_CONFIG', '/deployment/profile.yml');
  expect(configuredDshNativeLaunch()).toEqual({
    command: '/deployment/node',
    args: ['/deployment/entry.mjs'],
    profile: '/deployment/profile.yml',
  });
  expect(
    configuredDshNativeLaunch({
      runtimeCommand: process.execPath,
      runtimeArgs: ['/approved/entry.mjs'],
      cordisConfig: '/approved/profile.yml',
    }),
  ).toEqual({
    command: process.execPath,
    args: ['/approved/entry.mjs'],
    profile: '/approved/profile.yml',
  });
});

it('rejects malformed deployment arguments before any launch', () => {
  vi.stubEnv('ALLRICE_DSH_RUNTIME_ARGS', '{"not":"arguments"}');
  expect(() => configuredDshNativeLaunch()).toThrow('ALLRICE_DSH_RUNTIME_ARGS');
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'allrice-runtime-reuse-'));
  vi.stubEnv('ALLRICE_DSH_PLATFORM_HOME', join(root, 'platform'));
});
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function pool(native = false, capturePrompt?: string) {
  const fixturePath = resolve(
    import.meta.dirname,
    native
      ? '../../../dsh/allrice-jsonrpc-runtime.mjs'
      : '../fixtures/dsh-fake-runtime.mjs',
  );
  const instance = new DshRuntimePool({
    runtimeRoot: join(root, 'runtime'),
    runtimeCommand: process.execPath,
    runtimeArgs: capturePrompt
      ? [
          '--input-type=module',
          '--eval',
          `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(capturePrompt)}, process.env.DSH_SYSTEM_PROMPT); await import(${JSON.stringify(pathToFileURL(fixturePath).href)});`,
        ]
      : [fixturePath],
    credentialResolver: { resolve: async () => ({ apiKey: 'synthetic-only' }) },
    requestTimeoutMs: 15_000,
  });
  pools.push(instance);
  return instance;
}

/** Pool lifecycle seam only: these clients never spawn a native Host. */
function ownedClient(
  close: () => Promise<void>,
  sessionId: string = randomUUID(),
) {
  const runtime = {
    id: randomUUID(),
    sessionId,
    client: { close: vi.fn(close) },
  } as unknown as DshRuntime;
  return runtime;
}
function cachedRuntimes(instance: DshRuntimePool) {
  return Reflect.get(instance, 'runtimes') as Map<string, DshRuntime>;
}

it('owned close waits the original client even when the pool mapping is already empty', async () => {
  const runtimes = pool();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = ownedClient(() => pending);
  let closed = false;
  const confirmation = runtimes.closeOwned(original).then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(original.client.close).toHaveBeenCalledOnce();
  expect(closed).toBe(false);
  release();
  await confirmation;
  expect(closed).toBe(true);
});

it('owned close removes only its own current mapping', async () => {
  const runtimes = pool(),
    original = ownedClient(async () => {});
  cachedRuntimes(runtimes).set(original.sessionId, original);
  await runtimes.closeOwned(original);
  expect(runtimes.get(original.sessionId)).toBeUndefined();
  expect(original.client.close).toHaveBeenCalledOnce();
});

it('owned close leaves a same-key replacement running and closes only the captured instance', async () => {
  const runtimes = pool(),
    original = ownedClient(async () => {}),
    replacement = ownedClient(async () => {}, original.sessionId);
  cachedRuntimes(runtimes).set(original.sessionId, replacement);
  await runtimes.closeOwned(original);
  expect(runtimes.get(original.sessionId)).toBe(replacement);
  expect(original.client.close).toHaveBeenCalledOnce();
  expect(replacement.client.close).not.toHaveBeenCalled();
});

it('owned close joins the original pending close after global pool shutdown cleared its mapping', async () => {
  const runtimes = pool();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = ownedClient(() => pending);
  cachedRuntimes(runtimes).set(original.sessionId, original);
  const globalClose = runtimes.close();
  expect(runtimes.get(original.sessionId)).toBeUndefined();
  let confirmed = false;
  const ownClose = runtimes.closeOwned(original).then(() => {
    confirmed = true;
  });
  await Promise.resolve();
  expect(confirmed).toBe(false);
  release();
  await Promise.all([globalClose, ownClose]);
  expect(confirmed).toBe(true);
});

it('owned close rejection remains unconfirmed and does not close a replacement', async () => {
  const runtimes = pool(),
    failure = Error('original close unconfirmed'),
    original = ownedClient(() => Promise.reject(failure)),
    replacement = ownedClient(async () => {}, original.sessionId);
  cachedRuntimes(runtimes).set(original.sessionId, replacement);
  await expect(runtimes.closeOwned(original)).rejects.toBe(failure);
  expect(runtimes.get(original.sessionId)).toBe(replacement);
  expect(replacement.client.close).not.toHaveBeenCalled();
});

function request(): Parameters<DshRuntimePool['acquire']>[0] {
  const sessionId = randomUUID();
  const runId = randomUUID();
  const input: HarnessExecutionInput = {
    kernel: {
      schemaVersion: 1,
      harness: 'dsh',
      employeeAssignmentId: randomUUID(),
      employeeVersionId: randomUUID(),
      sessionId,
      userMessageId: randomUUID(),
      assistantMessageId: randomUUID(),
      systemInstructions: 'Synthetic session reuse; no model calls.',
      userRequest: 'Synthetic',
      bootstrapConversation: '',
      authorizedMemoryContext: '',
      grantedCapabilities: [],
      skillVersionIds: [],
      imageAttachments: [],
    },
    providerSnapshot: {
      provider: 'dsh',
      route: 'openai-compatible',
      authMode: 'allrice_credential',
      model: 'synthetic-model',
      credentialReference: 'test:synthetic',
      baseUrl: 'http://127.0.0.1:1/v1',
      reasoningEffort: 'none',
    },
    executionEnvironment: {
      ALLRICE_ORGANIZATION_ID: randomUUID(),
      ALLRICE_WORKSPACE_ID: randomUUID(),
      ALLRICE_OWNER_ID: randomUUID(),
      ALLRICE_RUN_ID: runId,
    },
    assistants: {
      deliveryMode: 'legacy',
      rootRunId: runId,
      maxOutputTokens: 1000,
      bind: async () => {
        throw Error('Pool acquisition must not dispatch a model or controller');
      },
    },
    maxOutputTokens: 1000,
    tools: [],
    storageObjects: [],
    workDirectory: root,
    signal: new AbortController().signal,
    attempt: 1,
    generation: 0,
    onEvent: async () => {},
  };
  return {
    input,
    snapshot: input.providerSnapshot as Parameters<
      DshRuntimePool['acquire']
    >[0]['snapshot'],
    threadId: `dsh-${sessionId}`,
    systemInstructions: input.kernel.systemInstructions,
    nativeSkills: [],
  };
}

/** The verified artifact/SQL ports are seams here. The child is the existing
 * protocol fixture: this tests Worker binding/reuse, not production approval. */
function currentExecutionRequest(variant: 'definition' | 'legacy' | 'current') {
  const runtimes = pool(),
    value = request();
  const artifactId = 'sha256:' + 'c'.repeat(64);
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', artifactId);
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', artifactId);
  const manifest = employeeManifest({
    key: 'current-pool',
    name: 'Synthetic current pool',
    description: 'Synthetic Worker binding fixture',
    toolNames: [],
    runtimePolicy: {
      harness: 'dsh',
      provider: 'openai-compatible',
      model: 'synthetic-model',
      reasoningEffort: 'low',
      timeoutMs: 300000,
      fallbackModels: [],
      credentialReference: 'test:synthetic',
      baseUrl: 'http://127.0.0.1:1/v1',
    },
  });
  if (manifest.schemaVersion !== 2)
    throw Error('Expected current fixture definition');
  if (variant !== 'definition') {
    const { harness: ignored, ...modelPolicy } = manifest.runtimePolicy;
    void ignored;
    const definition = PlatformEmployeeDefinitionSchema.parse({
      schemaVersion: 1,
      key: manifest.key,
      name: manifest.name,
      description: manifest.description,
      appearance: manifest.appearance,
      identity: {
        ...manifest.identity,
        expressionStyle: 'structured',
        outputLanguage: 'zh-CN',
      },
      systemPrompt: manifest.systemPrompt,
      modelPolicy,
      capabilities: {
        nativeSkillIds: [],
        workflowRevisionIds: [],
        knowledgeRevisionIds: [],
        toolNames: [],
        connectorRefs: [],
      },
      securityPolicy: { ...manifest.securityPolicy, bridgeAccess: 'none' },
    });
    const content = '# Synthetic reviewed capability\nNo tools required.\n';
    const bundle = {
      schemaVersion: 1 as const,
      version: '1.0.0',
      contentChecksum: skillBytesChecksum(content),
      sourceRef: 'https://example.test/reviewed',
      license: 'Apache-2.0',
      reviewedBy: 'fixture-reviewer',
      resources: [],
      dependencies: [],
    };
    const pkg = buildEmployeeRuntimePackage({
      revision: 1,
      definition,
      skills: [
        {
          id: randomUUID(),
          name: 'synthetic-reviewed',
          description: 'Synthetic capability fixture',
          content,
          checksum: skillBytesChecksum(content),
          model_invocable: true,
          user_invocable: true,
          required_tool_refs: [],
          source: 'allrice',
          source_ref: bundle.sourceRef,
          version: bundle.version,
          license: bundle.license,
          review_status: 'reviewed',
          reviewed_by_label: bundle.reviewedBy,
          reviewed_at: new Date('2026-10-01T00:00:00Z'),
          bundle: { ...bundle, checksum: skillBundleChecksum(bundle) },
        },
      ],
    });
    if (variant === 'legacy') {
      pkg.runtimeManifest.distributionGeneration =
        DSH_MISSING_FROZEN_GENERATION;
      pkg.capabilityFingerprint = runtimePackageChecksum({
        distributionGeneration: DSH_MISSING_FROZEN_GENERATION,
        provider: pkg.runtimeManifest.provider,
        model: pkg.runtimeManifest.model,
        tools: [],
        skills: pkg.skills.map((skill) => ({
          name: skill.name,
          checksum: skill.checksum,
          requiredToolRefs: [],
          bundleChecksum: skill.bundle!.checksum,
        })),
        deniedCapabilities: [...pkg.runtimeManifest.deniedCapabilities].sort(),
      });
      pkg.checksum = runtimePackageChecksum({
        schemaVersion: pkg.schemaVersion,
        packageVersion: pkg.packageVersion,
        capabilityFingerprint: pkg.capabilityFingerprint,
        files: {
          identityMd: pkg.files.identityMd,
          soulMd: pkg.files.soulMd,
          userMd: pkg.files.userMd,
          agentsMd: pkg.files.agentsMd,
        },
        skills: pkg.skills,
        runtimeManifest: pkg.runtimeManifest,
      });
    }
    manifest.runtimePackage = pkg;
    value.input.kernel.runtimePackageChecksum = pkg.checksum;
    value.input.kernel.runtimeDistributionGeneration =
      pkg.runtimeManifest.distributionGeneration;
  }
  const sourceInput = {
    employeeVersionId: value.input.kernel.employeeVersionId,
    configChecksum:
      manifest.runtimePackage?.checksum ?? employeeManifestChecksum(manifest),
    manifest,
  };
  const scope = {
    organizationId: value.input.executionEnvironment.ALLRICE_ORGANIZATION_ID!,
    workspaceId: value.input.executionEnvironment.ALLRICE_WORKSPACE_ID!,
    ownerId: value.input.executionEnvironment.ALLRICE_OWNER_ID!,
    sessionId: value.input.kernel.sessionId!,
    runId: value.input.executionEnvironment.ALLRICE_RUN_ID!,
  };
  const origin = newCurrentEmployeeChatOrigin({
    ...scope,
    source: sourceInput,
  });
  const payload = {
    schemaVersion: 1 as const,
    kind: 'current_employee_execution' as const,
    scope,
    originDigest: nativeRootDigest(origin),
    ...validateEmployeeExecutionSource(sourceInput),
    execution: {
      artifactId,
      generation: origin.distributionGeneration,
      profileId: origin.profileId,
    },
    executionSnapshotDigest: nativeRootDigest({ trustedSqlFixture: true }),
  };
  const executionBinding = EmployeeRunExecutionBindingSchema.parse({
    ...payload,
    digest: nativeRootDigest(payload),
  });
  const launch = {
    artifactId,
    generation: origin.distributionGeneration,
    version: '0.2.1-rc.2',
    command: process.execPath,
    args: [resolve(import.meta.dirname, '../fixtures/dsh-fake-runtime.mjs')],
    profile: join(root, 'synthetic-profile.yml'),
  };
  vi.spyOn(NativeArtifact, 'checkedDshNativeLaunch').mockReturnValue({
    artifactId,
    profileId: 'restricted',
  });
  vi.spyOn(NativeArtifact, 'nativeArtifactLaunchForPin').mockImplementation(
    (input) => {
      if (input.artifactId !== artifactId || input.profileId !== 'restricted')
        throw Error('unapproved fixture executor');
      return launch;
    },
  );
  vi.spyOn(NativeRetention, 'originDshNativeLaunch').mockReturnValue(launch);
  vi.spyOn(NativeRetention, 'pinnedDshNativeLaunch').mockReturnValue(launch);
  const descriptor = runtimes.describeNativeSession(
    value.input,
    value.threadId,
    undefined,
    origin,
    executionBinding,
  )!;
  const pin = {
    ...descriptor,
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    ownerId: scope.ownerId,
    contextKind: 'chat' as const,
    contextId: scope.sessionId,
    firstRunId: scope.runId,
    firstJobId: randomUUID(),
    firstAttempt: 1,
    boundAt: new Date().toISOString(),
    bindingBasis: 'business_root_origin' as const,
    rootOriginDigest: nativeRootDigest(origin),
  };
  return {
    runtimes,
    value: {
      ...value,
      nativeOrigin: origin,
      nativeExecutionBinding: executionBinding,
      nativePin: pin,
    },
    payload,
    launch,
  };
}

it.each(['definition', 'legacy', 'current'] as const)(
  'uses the SQL-bound current executor for %s sources without rewriting the kernel',
  (variant) => {
    const { runtimes, value, launch } = currentExecutionRequest(variant);
    const before = structuredClone(value.input.kernel);
    expect(
      runtimes.describeNativeSession(
        value.input,
        value.threadId,
        value.nativePin,
        value.nativeOrigin,
        value.nativeExecutionBinding,
      ),
    ).toMatchObject({
      artifactId: launch.artifactId,
      distributionGeneration: 'dsh-0.2.1-rc.2-687f282',
      profileId: 'restricted',
    });
    expect(value.input.kernel).toEqual(before);
    expect(value.input.kernel.runtimeDistributionGeneration).toBe(
      variant === 'definition'
        ? undefined
        : variant === 'legacy'
          ? DSH_MISSING_FROZEN_GENERATION
          : launch.generation,
    );
  },
);

it.each([
  'run',
  'owner',
  'workspace',
  'session',
  'version',
  'checksum',
  'generation',
  'missing-binding',
  'missing-origin',
  'corrupt-digest',
] as const)(
  'refuses a current executor binding with changed %s before starting a native child',
  async (changed) => {
    const { runtimes, value } = currentExecutionRequest('legacy');
    const next: Parameters<DshRuntimePool['acquire']>[0] = {
      ...value,
      input: {
        ...value.input,
        kernel: { ...value.input.kernel },
        executionEnvironment: { ...value.input.executionEnvironment },
      },
    };
    if (changed === 'run' || changed === 'owner' || changed === 'workspace')
      next.input.executionEnvironment = {
        ...next.input.executionEnvironment,
        [changed === 'run'
          ? 'ALLRICE_RUN_ID'
          : changed === 'owner'
            ? 'ALLRICE_OWNER_ID'
            : 'ALLRICE_WORKSPACE_ID']: randomUUID(),
      };
    if (changed === 'session') next.input.kernel.sessionId = randomUUID();
    if (changed === 'version')
      next.input.kernel.employeeVersionId = randomUUID();
    if (changed === 'checksum')
      next.input.kernel.runtimePackageChecksum = 'sha256:' + 'b'.repeat(64);
    if (changed === 'generation')
      next.input.kernel.runtimeDistributionGeneration = 'unreviewed';
    if (changed === 'missing-binding') next.nativeExecutionBinding = null;
    if (changed === 'missing-origin') next.nativeOrigin = null;
    if (changed === 'corrupt-digest')
      next.nativeExecutionBinding = {
        ...value.nativeExecutionBinding,
        digest: 'sha256:' + 'b'.repeat(64),
      };
    await expect(runtimes.acquire(next)).rejects.toThrow();
    expect(runtimes.get(value.threadId)).toBeUndefined();
  },
);

it.each(['definition', 'legacy', 'current'] as const)(
  'checks recovery storage for a %s source using its current SQL execution binding',
  async (variant) => {
    const { runtimes, value } = currentExecutionRequest(variant);
    // The real pool must reach the exact storage port with current execution,
    // even when the original definition declares a legacy/absent generation.
    // Stop at that port; this is not another fake Host startup or recovery QA.
    const storageUnavailable = new Error('synthetic storage unavailable');
    const reader = vi
      .spyOn(NativeStorage, 'assertStoredNativeSession')
      .mockRejectedValue(storageUnavailable);
    await expect(
      runtimes.acquire({ ...value, requireRecovery: true }),
    ).rejects.toBe(storageUnavailable);
    expect(runtimes.get(value.threadId)).toBeUndefined();
    expect(reader).toHaveBeenCalledTimes(1);
    expect(
      reader.mock.calls.every(
        (call) =>
          call[1].nativeSessionId === value.nativePin.nativeSessionId &&
          call[1].artifactId === value.nativePin.artifactId,
      ),
    ).toBe(true);
  },
);

it('reuses one current executor across Run bindings while rechecking the new Run identity', async () => {
  const { runtimes, value, payload } = currentExecutionRequest('legacy');
  const first = await runtimes.acquire(value);
  const nextRun = randomUUID();
  const nextPayload = {
    ...payload,
    scope: { ...payload.scope, runId: nextRun },
  };
  const next = {
    ...value,
    nativeExecutionBinding: EmployeeRunExecutionBindingSchema.parse({
      ...nextPayload,
      digest: nativeRootDigest(nextPayload),
    }),
    input: {
      ...value.input,
      executionEnvironment: {
        ...value.input.executionEnvironment,
        ALLRICE_RUN_ID: nextRun,
      },
      assistants: { ...value.input.assistants!, rootRunId: nextRun },
    },
  };
  const second = await runtimes.acquire(next);
  expect(second.runtime).toBe(first.runtime);
  expect(second.preparation).toMatchObject({
    cache: 'hit',
    reason: 'reused',
    changedFields: [],
  });
  expect(second.runtime.fingerprintParts).not.toHaveProperty(
    'nativeExecutionBinding',
  );
  expect(second.runtime.fingerprintParts).not.toHaveProperty('runId');
});

async function codexRequest() {
  const platform = join(root, 'platform');
  await mkdir(platform, { recursive: true });
  vi.spyOn(CodexSubscription, 'activeCodexSubscriptionHome').mockResolvedValue(
    platform,
  );
  const path = join(platform, '.credentials.yaml');
  const document = `version: 1
refs: {}
records:
  llm-pi-ai/openai-codex:
    kind: grant
    payload:
      type: oauth
      access: synthetic-only-one
      refresh: synthetic-refresh
      expires: 4102444800000
      accountId: synthetic-account
`;
  const timestamp = new Date('2026-01-01T00:00:00Z');
  await writeFile(path, document, { mode: 0o600 });
  await utimes(path, timestamp, timestamp);
  const input = request();
  input.snapshot = {
    ...input.snapshot,
    route: 'openai-codex',
    authMode: 'platform_subscription',
    credentialReference: 'test:codex',
    model: 'gpt-6.1-sol',
  };
  input.input.providerSnapshot = input.snapshot;
  return { input, path, document, timestamp };
}

it.each([false, true])(
  'keeps a warm Codex runtime when the credential file is replaced with identical bytes (native=%s)',
  async (native) => {
    const { input, path, document, timestamp } = await codexRequest();
    const runtimes = pool(native);
    const cold = await runtimes.acquire(input);
    const close = vi.spyOn(cold.runtime.client, 'close');
    await writeFile(path + '.replacement', document, { mode: 0o600 });
    await rename(path + '.replacement', path);
    const rewrittenAt = new Date(timestamp.getTime() + 1000);
    await utimes(path, rewrittenAt, rewrittenAt);

    const warm = await runtimes.acquire(input);
    expect(warm.fresh).toBe(false);
    expect(warm.runtime).toBe(cold.runtime);
    expect(warm.preparation).toMatchObject({
      cache: 'hit',
      reason: 'reused',
      changedFields: [],
      initializeMs: 0,
    });
    expect(close).not.toHaveBeenCalled();
    if (native)
      await expect(warm.runtime.client.providerStatus()).resolves.toMatchObject(
        {
          configured: true,
        },
      );
  },
  30_000,
);

it.each([false, true])(
  'rebuilds a Codex runtime when credential bytes change even if file size and mtime are preserved (native=%s)',
  async (native) => {
    const { input, path, document, timestamp } = await codexRequest();
    const runtimes = pool(native);
    const cold = await runtimes.acquire(input);
    const close = vi.spyOn(cold.runtime.client, 'close');
    const original = await stat(path);
    await writeFile(path, document.replace('one', 'two'));
    await utimes(path, timestamp, timestamp);
    const changedMetadata = await stat(path);
    expect(changedMetadata.size).toBe(original.size);
    expect(changedMetadata.mtimeMs).toBe(original.mtimeMs);

    const changed = await runtimes.acquire(input);
    expect(changed.fresh).toBe(true);
    expect(changed.runtime).not.toBe(cold.runtime);
    expect(changed.preparation).toMatchObject({
      cache: 'miss',
      reason: 'configuration_changed',
      changedFields: ['credentialDigest'],
    });
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.stringify(changed.preparation)).not.toContain('synthetic-only');
  },
  30_000,
);

it('refuses warm Codex reuse after the credential file is removed', async () => {
  const { input, path } = await codexRequest();
  const runtimes = pool();
  await runtimes.acquire(input);
  await rm(path);
  await expect(runtimes.acquire(input)).rejects.toMatchObject({
    code: 'CODEX_SUBSCRIPTION_AUTH_REQUIRED',
  });
});

it('rebuilds after switching subscription slots even with identical credential bytes', async () => {
  const { input, document } = await codexRequest();
  const runtimes = pool();
  const cold = await runtimes.acquire(input);
  const otherHome = join(root, 'platform', 'codex-subscriptions', '2');
  await mkdir(otherHome, { recursive: true });
  await writeFile(join(otherHome, '.credentials.yaml'), document, {
    mode: 0o600,
  });
  vi.mocked(CodexSubscription.activeCodexSubscriptionHome).mockResolvedValue(
    otherHome,
  );

  const switched = await runtimes.acquire(input);
  expect(switched.fresh).toBe(true);
  expect(switched.runtime).not.toBe(cold.runtime);
  expect(switched.preparation.changedFields).toEqual(['codexSubscriptionHome']);
});

it.each([false, true])(
  'scopes the actual DSH startup prompt without granting managed Office (office supplied=%s)',
  async (officeSupplied) => {
    vi.stubEnv('ALLRICE_LOCAL_COMMAND_ENABLED', '0');
    const promptPath = join(root, 'synthetic-system-prompt.txt');
    const runtimes = pool(false, promptPath);
    const first = request();
    if (officeSupplied)
      first.input.tools = [
        {
          name: 'workspace.export.create',
          description: 'Managed Office export',
          inputSchema: { type: 'object' },
        },
      ];
    const started = await runtimes.acquire(first);
    const prompt = await readFile(promptPath, 'utf8');
    expect(prompt).toContain(first.systemInstructions);
    expect(prompt).toContain('on the DSH Worker host is disabled');
    expect(prompt).toContain('within their frozen authorization');
    expect(prompt).not.toContain('All host capabilities are disabled');
    expect(prompt.includes('independent of local.process.execute')).toBe(
      officeSupplied,
    );
    expect(started.runtime.nativeTools).toEqual(
      officeSupplied ? ['workspace.export.create'] : [],
    );
  },
);

it('reuses the session process across business Runs with assistants enabled', async () => {
  const runtimes = pool();
  const first = request();
  const cold = await runtimes.acquire(first);
  const close = vi.spyOn(cold.runtime.client, 'close');
  const nextRun = randomUUID();
  const warm = await runtimes.acquire({
    ...first,
    input: {
      ...first.input,
      assistants: { ...first.input.assistants!, rootRunId: nextRun },
      executionEnvironment: {
        ...first.input.executionEnvironment,
        ALLRICE_RUN_ID: nextRun,
      },
    },
  });
  expect(cold.fresh).toBe(true);
  expect(cold.preparation).toMatchObject({
    cache: 'miss',
    reason: 'not_resident',
    changedFields: [],
    skillRegistrationMs: null,
  });
  expect(warm.fresh).toBe(false);
  expect(warm.preparation).toMatchObject({
    cache: 'hit',
    reason: 'reused',
    changedFields: [],
    initializeMs: 0,
    skillRegistrationMs: 0,
  });
  expect(warm.runtime).toBe(cold.runtime);
  expect(close).not.toHaveBeenCalled();
});

it.each([false, true])(
  'keeps the complete schedule capability and resident process across once → recurring → once (native=%s)',
  async (native) => {
    const runtimes = pool(native);
    const first = request();
    first.input.tools = [
      {
        name: 'automation.create',
        description: 'Create a task',
        inputSchema: {},
      },
    ];
    first.input.currentUserRequest = '请在15分钟后提醒我喝水。';
    const once = await runtimes.acquire(first);
    const closeOnce = vi.spyOn(once.runtime.client, 'close');
    expect(once.runtime.nativeTools).toEqual([]);

    first.input.currentUserRequest = '请每隔两分钟提醒我喝水。';
    const recurring = await runtimes.acquire(first);
    const closeRecurring = vi.spyOn(recurring.runtime.client, 'close');
    expect(recurring.runtime.nativeTools).toEqual([]);
    expect(recurring.preparation.changedFields).toEqual([]);
    expect(recurring.fresh).toBe(false);
    expect(recurring.runtime).toBe(once.runtime);
    expect(closeOnce).not.toHaveBeenCalled();
    for (const key of [
      'sessionId',
      'productSessionId',
      'organizationId',
      'workspaceId',
      'ownerId',
      'nativeArtifactId',
      'nativeProfileId',
      'nativePin',
    ] as const)
      expect(recurring.runtime[key]).toEqual(once.runtime[key]);

    // Different recurring text is data for the next Run, not a process key.
    first.input.currentUserRequest = '请每隔十五分钟提醒我检查报表。';
    const warm = await runtimes.acquire(first);
    expect(warm.runtime).toBe(recurring.runtime);
    expect(warm.preparation.changedFields).toEqual([]);
    expect(closeRecurring).not.toHaveBeenCalled();

    first.input.currentUserRequest = '请在15分钟后提醒我喝水。';
    const restored = await runtimes.acquire(first);
    expect(restored.runtime.nativeTools).toEqual([]);
    expect(restored.preparation.changedFields).toEqual([]);
    expect(restored.runtime.fingerprint).toBe(once.runtime.fingerprint);
    expect(restored.runtime.sessionId).toBe(once.runtime.sessionId);
    expect(closeRecurring).not.toHaveBeenCalled();
  },
  30_000,
);

it('keeps schedule transport independent of human wording, template, tool, memory and attachment text without changing tenant authority', async () => {
  const runtimes = pool();
  const input = request();
  const recurring = '请每隔两分钟提醒我喝水。';
  input.input.kernel.userRequest = recurring;
  input.input.kernel.authorizedMemoryContext = recurring;
  input.input.images = [
    { mediaType: 'image/png', data: 'c3ludGhldGlj', name: recurring },
  ];
  input.input.tools = [
    {
      name: 'automation.create',
      description: recurring,
      inputSchema: { type: 'object', description: recurring },
    },
  ];
  const absent = await runtimes.acquire(input);
  expect(absent.runtime.nativeTools).toEqual([]);
  input.input.currentUserRequest = '请在15分钟后提醒我喝水。';
  const rawOnce = await runtimes.acquire(input);
  expect(rawOnce.runtime).toBe(absent.runtime);

  input.input.currentUserRequest = recurring;
  input.input.kernel.userRequest = `${recurring}\n\nExplicitly selected company templates (untrusted business references)\n{"title":"请解释这个示例"}`;
  const rawRecurring = await runtimes.acquire(input);
  expect(rawRecurring.runtime.nativeTools).toEqual([]);
  expect(rawRecurring.preparation.changedFields).toEqual([]);
  expect(rawRecurring.runtime).toBe(absent.runtime);

  // Neither request text nor the stable transport bypasses the resident tenant binding check.
  const close = vi.spyOn(rawRecurring.runtime.client, 'close');
  input.input.currentUserRequest = '请在15分钟后提醒我喝水。';
  input.input.executionEnvironment = {
    ...input.input.executionEnvironment,
    ALLRICE_OWNER_ID: randomUUID(),
  };
  await expect(runtimes.acquire(input)).rejects.toMatchObject({
    code: 'DSH_NATIVE_SESSION_BINDING_CONFLICT',
  });
  expect(close).not.toHaveBeenCalled();
});

it.each(['owner', 'workspace', 'session'] as const)(
  'never replaces another resident context when %s differs',
  async (change) => {
    const runtimes = pool(),
      first = request(),
      created = await runtimes.acquire(first),
      close = vi.spyOn(created.runtime.client, 'close');
    const next = {
      ...first,
      input: {
        ...first.input,
        kernel: { ...first.input.kernel },
        executionEnvironment: { ...first.input.executionEnvironment },
      },
    };
    if (change === 'session') next.input.kernel.sessionId = randomUUID();
    else
      next.input.executionEnvironment = {
        ...next.input.executionEnvironment,
        [change === 'owner' ? 'ALLRICE_OWNER_ID' : 'ALLRICE_WORKSPACE_ID']:
          randomUUID(),
      };
    await expect(runtimes.acquire(next)).rejects.toMatchObject({
      code: 'DSH_NATIVE_SESSION_BINDING_CONFLICT',
    });
    expect(close).not.toHaveBeenCalled();
    expect(runtimes.get(first.threadId)).toBe(created.runtime);
  },
);

it.each(['assistant mode', 'assistant output cap', 'ordinary output cap'])(
  'restarts when process configuration changes: %s',
  async (change) => {
    const runtimes = pool();
    const first = request();
    if (change === 'ordinary output cap') first.input.assistants = undefined;
    const cold = await runtimes.acquire(first);
    const close = vi.spyOn(cold.runtime.client, 'close');
    if (change === 'assistant mode') first.input.assistants = undefined;
    else if (first.input.assistants)
      first.input.assistants.maxOutputTokens = 500;
    else first.input.maxOutputTokens = 500;
    const changed = await runtimes.acquire(first);
    expect(changed.fresh).toBe(true);
    expect(changed.preparation).toMatchObject({
      cache: 'miss',
      reason: 'configuration_changed',
      changedFields: [
        change === 'assistant mode' ? 'assistantsEnabled' : 'maxTokens',
      ],
    });
    expect(JSON.stringify(changed.preparation)).not.toContain('synthetic-only');
    expect(changed.runtime).not.toBe(cold.runtime);
    expect(close).toHaveBeenCalledOnce();
  },
);

it('the actual DSH host releases the old Run binding and accepts a new Run on the same warm process', async () => {
  const runtimes = pool(true);
  const first = request();
  const cold = await runtimes.acquire(first);
  expect(cold.preparation.skillRegistrationMs).toBeGreaterThanOrEqual(0);
  const bind = () => ({
    nativeSessionId: first.threadId,
    runId: first.input.assistants!.rootRunId,
    wireTools: [],
  });
  await expect(cold.runtime.client.assistant('bind', bind())).resolves.toEqual({
    bound: true,
  });
  // The real host must still reject overlapping authority before finish.
  await expect(cold.runtime.client.assistant('bind', bind())).rejects.toThrow();
  await expect(
    cold.runtime.client.assistant('finish', {
      nativeSessionId: first.threadId,
    }),
  ).resolves.toEqual({ released: true });
  first.input.assistants!.rootRunId = randomUUID();
  const warm = await runtimes.acquire(first);
  expect(warm.fresh).toBe(false);
  expect(warm.runtime).toBe(cold.runtime);
  await expect(warm.runtime.client.assistant('bind', bind())).resolves.toEqual({
    bound: true,
  });
  await warm.runtime.client.assistant('finish', {
    nativeSessionId: first.threadId,
  });
}, 30_000);
