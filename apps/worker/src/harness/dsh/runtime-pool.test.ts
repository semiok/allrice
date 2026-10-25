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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessExecutionInput } from '../adapter.js';
import * as CodexSubscription from '../../codex-subscription-home.js';
import * as NativeArtifact from '../dsh-native-artifact.js';
import * as NativeRetention from '../dsh-native-retention.js';
import * as NativeStorage from '../dsh-native-storage.js';
import * as CloseObserver from '../dsh-close-observer.js';
import {
  DSH_MISSING_FROZEN_GENERATION,
  PlatformEmployeeDefinitionSchema,
} from '@allrice/contracts';
import {
  employeeManifest,
  employeeManifestChecksum,
  buildEmployeeRuntimePackage,
  runtimePackageChecksum,
  EmployeeRunExecutionBindingSchema,
  nativeRootDigest,
  newCurrentEmployeeChatOrigin,
  validateEmployeeExecutionSource,
  skillBundleChecksum,
  skillBytesChecksum,
} from '@allrice/database';
import {
  DshRuntimePool,
  configuredDshNativeLaunch,
  dshIdleCloseMs,
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

function pool(native = false, capturePrompt?: string, idleCloseMs?: number) {
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
    idleCloseMs,
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

/** Ownership-only clients and the factory gate below never spawn a child. A
 * deliberately rejected close has no external resources for afterEach to reap. */
function ownershipPool() {
  return new DshRuntimePool({
    runtimeRoot: join(root, 'ownership'),
    runtimeCommand: process.execPath,
    runtimeArgs: ['/synthetic/never-spawned.mjs'],
    credentialResolver: { resolve: async () => ({ apiKey: 'synthetic-only' }) },
  });
}
function ownedRuntime(close: () => Promise<void>) {
  return Object.assign(ownedClient(close), { nativeTools: [] });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('global close preserves a rejection while attempting every captured owner', async () => {
  const instance = ownershipPool(),
    failure = Error('original close rejected');
  const failed = ownedRuntime(async () => {
    throw failure;
  });
  const other = ownedRuntime(async () => {});
  cachedRuntimes(instance).set(failed.sessionId, failed);
  cachedRuntimes(instance).set(other.sessionId, other);
  const closing = instance.close();
  await expect(closing).rejects.toBeInstanceOf(AggregateError);
  expect(failed.client.close).toHaveBeenCalledOnce();
  expect(other.client.close).toHaveBeenCalledOnce();
  expect(instance.close()).toBe(closing);
  expect(instance.closureInventory()).toMatchObject([
    { id: failed.id, state: 'unconfirmed' },
  ]);
});

it('concurrent global closes share the unresolved original promise and every owner', async () => {
  const instance = ownershipPool(),
    held = deferred();
  const original = ownedRuntime(() => held.promise);
  cachedRuntimes(instance).set(original.sessionId, original);
  let completed = false;
  const first = instance.close(),
    second = instance.close();
  expect(second).toBe(first);
  void second.then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  expect(original.client.close).toHaveBeenCalledOnce();
  held.resolve();
  await Promise.all([first, second]);
  expect(completed).toBe(true);
  expect(instance.closureInventory()).toEqual([]);
});

it('failed drop retains ownership for inventory, repeated drop and global close', async () => {
  const instance = ownershipPool(),
    failure = Error('drop unconfirmed');
  const original = ownedRuntime(async () => {
    throw failure;
  });
  cachedRuntimes(instance).set(original.sessionId, original);
  await expect(instance.drop(original.sessionId)).rejects.toBe(failure);
  expect(instance.get(original.sessionId)).toBeUndefined();
  expect(instance.inventory()).toMatchObject([{ id: original.id }]);
  expect(instance.closureInventory()).toMatchObject([
    { id: original.id, state: 'unconfirmed' },
  ]);
  await expect(instance.drop(original.sessionId)).rejects.toBeInstanceOf(
    AggregateError,
  );
  await expect(instance.close()).rejects.toBeInstanceOf(AggregateError);
  expect(original.client.close).toHaveBeenCalledOnce();
});

it('a witnessed exit stays owned until its durable close settles, without appearing live', async () => {
  const instance = ownershipPool(),
    held = deferred();
  const original = ownedRuntime(() => held.promise);
  Object.assign(original.client, {
    processState: () => ({
      state: 'exited',
      stdioClosed: true,
      exitCode: 0,
      signal: null,
    }),
  });
  const closing = instance.closeOwned(original);
  await Promise.resolve();
  expect(instance.inventory()).toEqual([]);
  expect(instance.closureInventory()).toMatchObject([
    { id: original.id, state: 'closing', processState: 'exited' },
  ]);
  held.resolve();
  await closing;
  expect(instance.closureInventory()).toEqual([]);
});

it('input hold disposal failure does not skip the original child close', async () => {
  const instance = ownershipPool(),
    failure = Error('hold disposal failed');
  const original = ownedRuntime(async () => {});
  vi.spyOn(instance, 'clearInputDelivery').mockImplementation(() => {
    throw failure;
  });
  await expect(instance.closeOwned(original)).rejects.toBe(failure);
  expect(original.client.close).toHaveBeenCalledOnce();
  expect(instance.closureInventory()).toMatchObject([
    { id: original.id, state: 'unconfirmed' },
  ]);
});

it.each([false, true])(
  'global close waits an in-flight owner reservation; write failure=%s',
  async (writeFailure) => {
    const instance = ownershipPool(),
      entered = deferred(),
      held = deferred();
    vi.spyOn(CloseObserver, 'createObservedDshClient').mockImplementation(
      async (input) => {
        entered.resolve();
        await held.promise;
        try {
          input.assertAdmissionOpen?.();
        } catch (error) {
          if (writeFailure)
            throw new AggregateError([
              error,
              Error('never-spawned receipt failed'),
            ]);
          throw error;
        }
        throw Error('The concurrent close must fence before any spawn');
      },
    );
    const acquisition = instance
      .acquire(request())
      .catch((error: unknown) => error);
    await entered.promise;
    let completed = false;
    const closing = instance.close();
    const result = closing.then(
      () => {
        completed = true;
        return null;
      },
      (error: unknown) => error,
    );
    await Promise.resolve();
    expect(completed).toBe(false);
    held.resolve();
    if (writeFailure) {
      expect(await acquisition).toBeInstanceOf(AggregateError);
      expect(await result).toBeInstanceOf(AggregateError);
    } else {
      expect(await acquisition).toMatchObject({
        code: 'DSH_RUNTIME_POOL_CLOSING',
      });
      expect(await result).toBeNull();
      expect(completed).toBe(true);
    }
    expect(CloseObserver.createObservedDshClient).toHaveBeenCalledOnce();
    expect(instance.inventory()).toEqual([]);
  },
);

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
  const runtimes = ownershipPool(),
    failure = Error('original close unconfirmed'),
    original = ownedClient(() => Promise.reject(failure)),
    replacement = ownedClient(async () => {}, original.sessionId);
  cachedRuntimes(runtimes).set(original.sessionId, replacement);
  await expect(runtimes.closeOwned(original)).rejects.toBe(failure);
  expect(runtimes.get(original.sessionId)).toBe(replacement);
  expect(replacement.client.close).not.toHaveBeenCalled();
  await expect(runtimes.close()).rejects.toBeInstanceOf(AggregateError);
  expect(original.client.close).toHaveBeenCalledOnce();
  expect(replacement.client.close).toHaveBeenCalledOnce();
  expect(runtimes.closureInventory()).toMatchObject([
    { id: original.id, state: 'unconfirmed' },
  ]);
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

describe('idle close (MET-216)', () => {
  const longAgo = () => new Date(Date.now() - 3_600_000).toISOString();
  /** Ownership-only pool: residents are synthetic and never spawn a child. */
  function idlePool(idleCloseMs: number) {
    return new DshRuntimePool({
      runtimeRoot: join(root, 'idle'),
      runtimeCommand: process.execPath,
      runtimeArgs: ['/synthetic/never-spawned.mjs'],
      credentialResolver: {
        resolve: async () => ({ apiKey: 'synthetic-only' }),
      },
      idleCloseMs,
    });
  }
  function resident(
    instance: DshRuntimePool,
    lastActivityAt = longAgo(),
    close: () => Promise<void> = async () => {},
    sessionId?: string,
  ) {
    const runtime = Object.assign(ownedClient(close, sessionId), {
      nativeTools: [],
      lastActivityAt,
    });
    cachedRuntimes(instance).set(runtime.sessionId, runtime);
    return runtime;
  }
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  it('reads ALLRICE_DSH_IDLE_CLOSE_MINUTES: 30 by default, 0 disables, otherwise at least 1, invalid fails loudly', () => {
    expect(dshIdleCloseMs(undefined)).toBe(1_800_000);
    expect(dshIdleCloseMs(' ')).toBe(1_800_000);
    expect(dshIdleCloseMs('0')).toBe(0);
    expect(dshIdleCloseMs(' 2 ')).toBe(120_000);
    expect(dshIdleCloseMs('1.5')).toBe(90_000);
    for (const invalid of [
      '-1',
      'thirty',
      'Infinity',
      '0.5',
      '0.000001',
      '1e2',
      '0x10',
      '9'.repeat(400),
    ])
      expect(() => dshIdleCloseMs(invalid)).toThrow(
        'ALLRICE_DSH_IDLE_CLOSE_MINUTES',
      );
    for (const idleCloseMs of [Number.NaN, -1, Number.POSITIVE_INFINITY])
      expect(() => idlePool(idleCloseMs)).toThrow(
        'ALLRICE_DSH_IDLE_CLOSE_MINUTES',
      );
    vi.stubEnv('ALLRICE_DSH_IDLE_CLOSE_MINUTES', 'soon');
    expect(
      () =>
        new DshRuntimePool({
          runtimeCommand: process.execPath,
          runtimeArgs: [],
        }),
    ).toThrow('ALLRICE_DSH_IDLE_CLOSE_MINUTES');
  });

  it('skips the whole sweep while the Worker gate is closed (database unready)', async () => {
    const instance = idlePool(60_000);
    pools.push(instance);
    const runtime = resident(instance);
    let ready = false;
    instance.setIdleCloseGate(() => ready);
    await instance.reclaimIdle();
    expect(runtime.client.close).not.toHaveBeenCalled();
    expect(instance.get(runtime.sessionId)).toBe(runtime);
    ready = true;
    await instance.reclaimIdle();
    expect(runtime.client.close).toHaveBeenCalledOnce();
  });

  it('closes one Host at a time and shares one sweep among concurrent callers', async () => {
    const instance = idlePool(60_000);
    pools.push(instance);
    const held = deferred();
    const first = resident(instance, longAgo(), () => held.promise),
      second = resident(instance);
    const sweep = instance.reclaimIdle();
    expect(instance.reclaimIdle()).toBe(sweep);
    await new Promise((done) => setTimeout(done, 20));
    expect(first.client.close).toHaveBeenCalledOnce();
    expect(second.client.close).not.toHaveBeenCalled();
    // Not yet selected, so a turn arriving now still reuses it.
    expect(instance.get(second.sessionId)).toBe(second);
    held.resolve();
    await sweep;
    expect(second.client.close).toHaveBeenCalledOnce();
    expect(instance.reclaimIdle()).not.toBe(sweep);
  });

  it('closes only Hosts idle past the limit, through the owned close', async () => {
    const instance = idlePool(60_000);
    pools.push(instance);
    const idle = resident(instance),
      active = resident(instance, new Date().toISOString());
    const owned = vi.spyOn(instance, 'closeOwned');
    await instance.reclaimIdle();
    expect(owned).toHaveBeenCalledOnce();
    expect(owned).toHaveBeenCalledWith(idle);
    expect(idle.client.close).toHaveBeenCalledOnce();
    expect(instance.get(idle.sessionId)).toBeUndefined();
    expect(instance.get(active.sessionId)).toBe(active);
    expect(active.client.close).not.toHaveBeenCalled();
    expect(instance.inventory().map((runtime) => runtime.id)).toEqual([
      active.id,
    ]);
    expect(instance.closureInventory()).toEqual([]);
  });

  it.each<[string, (pool: DshRuntimePool, runtime: DshRuntime) => void]>([
    [
      'an execution lease',
      (pool, runtime) => void pool.lease(runtime.sessionId),
    ],
    [
      'an unsettled steer',
      (pool, runtime) => {
        Object.assign(runtime.client, { steer: () => new Promise(() => {}) });
        void pool.steer(runtime.sessionId, 'synthetic steer');
      },
    ],
    [
      'an input-delivery hold',
      (pool, runtime) => {
        (Reflect.get(pool, 'inputHolds') as Map<DshRuntime, unknown>).set(
          runtime,
          { phase: 'paused', hold: { dispose() {} } },
        );
      },
    ],
    [
      'an unreadable activity time',
      (_pool, runtime) => {
        runtime.lastActivityAt = 'unknown';
      },
    ],
  ])('never closes an idle Host with %s', async (_reason, arrange) => {
    const instance = idlePool(60_000);
    pools.push(instance);
    const runtime = resident(instance);
    arrange(instance, runtime);
    await instance.reclaimIdle(Date.now() + 86_400_000);
    expect(runtime.client.close).not.toHaveBeenCalled();
    expect(instance.get(runtime.sessionId)).toBe(runtime);
  });

  it('closes nothing when disabled', async () => {
    const instance = idlePool(0);
    pools.push(instance);
    const runtime = resident(instance);
    await instance.reclaimIdle(Date.now() + 86_400_000);
    expect(runtime.client.close).not.toHaveBeenCalled();
    expect(Reflect.get(instance, 'idleTimer')).toBeUndefined();
  });

  it('nested leases keep the Host until the last release, which restarts the idle clock', async () => {
    const instance = idlePool(60_000);
    pools.push(instance);
    const runtime = resident(instance);
    const first = instance.lease(runtime.sessionId),
      second = instance.lease(runtime.sessionId);
    first();
    first(); // Idempotent: a repeated release never drops another holder.
    await instance.reclaimIdle();
    expect(runtime.client.close).not.toHaveBeenCalled();
    const released = Date.now();
    second();
    expect(Date.parse(runtime.lastActivityAt)).toBeGreaterThanOrEqual(released);
    await instance.reclaimIdle(released + 59_000);
    expect(runtime.client.close).not.toHaveBeenCalled();
    await instance.reclaimIdle(Date.parse(runtime.lastActivityAt) + 60_000);
    expect(runtime.client.close).toHaveBeenCalledOnce();
  });

  it('an acquisition racing an idle close waits for it and starts a fresh Host', async () => {
    const runtimes = pool(false, undefined, 60_000),
      value = request();
    const first = await runtimes.acquire(value);
    const held = deferred();
    const close = first.runtime.client.close.bind(first.runtime.client);
    vi.spyOn(first.runtime.client, 'close').mockImplementation(async () => {
      await held.promise;
      await close();
    });
    first.runtime.lastActivityAt = longAgo();
    const sweep = runtimes.reclaimIdle();
    // Selection removed the closing Host synchronously; it is never handed out.
    expect(runtimes.get(value.threadId)).toBeUndefined();
    let settled = false;
    const replacement = runtimes.acquire(value).finally(() => {
      settled = true;
    });
    await new Promise((done) => setTimeout(done, 50));
    expect(settled).toBe(false);
    held.resolve();
    const second = await replacement;
    await sweep;
    expect(second.fresh).toBe(true);
    expect(second.runtime).not.toBe(first.runtime);
    expect(first.runtime.client.close).toHaveBeenCalledOnce();
    expect(runtimes.inventory().map((runtime) => runtime.id)).toEqual([
      second.runtime.id,
    ]);
  });

  it('a lease or an in-flight acquisition taken before the sweep keeps the Host for reuse', async () => {
    const runtimes = pool(false, undefined, 60_000),
      value = request();
    const first = await runtimes.acquire(value);
    first.runtime.lastActivityAt = longAgo();
    const release = runtimes.lease(value.threadId);
    await runtimes.reclaimIdle();
    expect(await runtimes.acquire(value)).toMatchObject({
      fresh: false,
      runtime: first.runtime,
    });
    release();
    first.runtime.lastActivityAt = longAgo();
    // acquire() leases synchronously, before its first await.
    const reuse = runtimes.acquire(value);
    await runtimes.reclaimIdle();
    expect(await reuse).toMatchObject({ fresh: false, runtime: first.runtime });
    expect(first.runtime.client.processState?.().state).not.toBe('exited');
  });

  it('a failed idle close stays unconfirmed and refuses a same-thread replacement', async () => {
    const instance = idlePool(60_000),
      value = request(),
      failure = Error('idle close unconfirmed');
    const runtime = resident(
      instance,
      longAgo(),
      () => Promise.reject(failure),
      value.threadId,
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await instance.reclaimIdle();
    expect(logged).toHaveBeenCalledOnce();
    expect(instance.closureInventory()).toMatchObject([
      { id: runtime.id, state: 'unconfirmed' },
    ]);
    await expect(instance.acquire(value)).rejects.toMatchObject({
      code: 'DSH_RUNTIME_CLOSE_UNCONFIRMED',
    });
    await expect(instance.close()).rejects.toBeInstanceOf(AggregateError);
  });

  it('the sweep timer closes an idle Host on its own and stops with no residents', async () => {
    const runtimes = pool(false, undefined, 50);
    await runtimes.acquire(request());
    expect(Reflect.get(runtimes, 'idleTimer')).toBeDefined();
    await vi.waitFor(() => expect(runtimes.inventory()).toEqual([]), {
      timeout: 5_000,
    });
    await vi.waitFor(() =>
      expect(Reflect.get(runtimes, 'idleTimer')).toBeUndefined(),
    );
  });

  it('global close stops the sweep timer', async () => {
    const runtimes = pool(false, undefined, 60_000);
    await runtimes.acquire(request());
    expect(Reflect.get(runtimes, 'idleTimer')).toBeDefined();
    await runtimes.close();
    expect(Reflect.get(runtimes, 'idleTimer')).toBeUndefined();
    await runtimes.reclaimIdle(Date.now() + 86_400_000);
  });

  it('retains input holds through pending pause and release acknowledgements until cleanup', async () => {
    const instance = idlePool(60_000);
    pools.push(instance);
    const runtime = resident(instance);
    const pause = deferred(),
      resume = deferred();
    const hold = {
      settled: pause.promise,
      current: () => true,
      resumeBeforeTurnClose: vi.fn(() => resume.promise),
      dispose: vi.fn(),
    };
    const params = {
      gateId: randomUUID(),
      nativeSessionId: runtime.sessionId,
      runId: randomUUID(),
      turnId: 'held-turn',
    };
    const context = {
      runId: params.runId,
      turnId: () => params.turnId,
      signal: new AbortController().signal,
      delivery: { pause: () => hold },
      assertAuthority: async () => {},
    };
    const notReclaimed = async () => {
      await instance.reclaimIdle(Date.now() + 86_400_000);
      expect(instance.get(runtime.sessionId)).toBe(runtime);
      expect(runtime.client.close).not.toHaveBeenCalled();
    };
    try {
      const pausing = instance.inputDeliveryControl(
        runtime,
        'pause',
        params,
        context,
      );
      await notReclaimed();
      pause.resolve();
      await expect(pausing).resolves.toMatchObject({ paused: true });
      await notReclaimed();
      const releasing = instance.inputDeliveryControl(
        runtime,
        'release',
        params,
        context,
      );
      expect(hold.resumeBeforeTurnClose).toHaveBeenCalledOnce();
      await notReclaimed();
      resume.resolve();
      await expect(releasing).resolves.toMatchObject({ released: true });
      await notReclaimed();
      instance.clearInputDelivery(runtime);
      await instance.reclaimIdle(Date.now() + 86_400_000);
      expect(runtime.client.close).toHaveBeenCalledOnce();
    } finally {
      pause.resolve();
      resume.resolve();
    }
  });

  it.each(['idle-first', 'worker-first'] as const)(
    'coalesces idle reclaim with Worker close and fences new requests (%s)',
    async (order) => {
      const runtimes = pool(false, undefined, 60_000),
        value = request();
      const { runtime } = await runtimes.acquire(value);
      runtime.lastActivityAt = longAgo();
      const entered = deferred(),
        released = deferred();
      const close = runtime.client.close.bind(runtime.client);
      const physicalClose = vi
        .spyOn(runtime.client, 'close')
        .mockImplementation(async () => {
          entered.resolve();
          await released.promise;
          await close();
        });
      let shutdownSettled = false;
      const sweep = order === 'idle-first' ? runtimes.reclaimIdle() : undefined;
      const shutdown = runtimes.close().then(() => {
        shutdownSettled = true;
      });
      try {
        await entered.promise;
        if (!sweep) await runtimes.reclaimIdle(Date.now() + 86_400_000);
        expect(shutdownSettled).toBe(false);
        expect(physicalClose).toHaveBeenCalledOnce();
        expect(runtimes.closureInventory()).toMatchObject([
          { id: runtime.id, state: 'closing' },
        ]);
        const acquire = runtimes.acquire(value);
        const denied = expect(acquire).rejects.toMatchObject({
          code: 'DSH_RUNTIME_POOL_CLOSING',
        });
        released.resolve();
        await Promise.all([sweep, shutdown, denied]);
        expect(physicalClose).toHaveBeenCalledOnce();
        expect(runtime.client.processState().state).toBe('exited');
        expect(runtimes.inventory()).toEqual([]);
        expect(runtimes.closureInventory()).toEqual([]);
      } finally {
        released.resolve();
        await Promise.allSettled([sweep, shutdown]);
      }
    },
  );
});
