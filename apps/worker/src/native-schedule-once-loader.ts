import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import { DSH_INSTALLED_DISTRIBUTION } from '@allrice/contracts';
import {
  currentDshNativeControlArtifact,
  type ApprovedDshNativeControlArtifact,
} from './harness/dsh-native-artifact.js';
import {
  NativeScheduleOnceError,
  type NativeScheduleControlReference,
  type NativeScheduleControlSource,
  type NativeSchedulePublicModules,
} from './native-schedule-once.js';
import { createNativeOnceWorkerRuntime } from './native-schedule-once-runtime.js';

const FACTORY = 'apps/worker/dsh/native-schedule-host-factory.mjs';
const moduleNames = {
  cordis: 'cordis',
  llm: 'dsh-llm',
  sessions: 'dsh-session',
  projections: 'dsh-session-projection',
  systemPrompt: 'dsh-system-prompt',
  files: 'dsh-fs-local',
  directory: 'dsh-working-directory',
  tools: 'dsh-tools',
  agents: 'dsh-agent',
  loop: 'dsh-agent-loop',
  jsonl: 'dsh-session-persistence-jsonl',
  storage: 'dsh-storage',
  domain: 'dsh-storage-domain',
  workspace: 'dsh-workspace',
  typert: 'dsh-typert-registry',
  defaultModel: 'dsh-agent-default-model',
  credentials: 'dsh-credentials',
  commands: 'dsh-commands',
  connection: 'dsh-client-connection',
  attachment: 'dsh-attachment-local',
  upload: 'dsh-client-file-upload',
  query: 'dsh-session-query-sqlite',
  controller: 'dsh-api-session-controller',
  sdk: 'dsh-sdk-jsonrpc-server',
  schedule: 'dsh-schedule',
} as const;
const invalid = (): never => {
  throw new NativeScheduleOnceError('binding_invalid');
};

export function parseNativeScheduleControlReference(
  value: unknown,
): NativeScheduleControlReference {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const fields = ['artifactId', 'profileId', 'storageId', 'stateRoot'];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== fields.length ||
    fields.some((key) => {
      const d = descriptors[key];
      return (
        !d ||
        !('value' in d) ||
        !d.enumerable ||
        typeof d.value !== 'string' ||
        !d.value.length
      );
    })
  )
    return invalid();
  const ref = value as NativeScheduleControlReference;
  if (
    !/^sha256:[a-f0-9]{64}$/.test(ref.artifactId) ||
    !['allrice-once-control-v1', 'allrice-recurring-control-v1'].includes(
      ref.profileId,
    ) ||
    Buffer.byteLength(ref.storageId) > 512 ||
    Buffer.byteLength(ref.stateRoot) > 4096 ||
    !isAbsolute(ref.stateRoot) ||
    resolve(ref.stateRoot) !== ref.stateRoot
  )
    return invalid();
  return Object.freeze(structuredClone(ref));
}

/** Historical once entry remains strict; new callers explicitly choose the new profile. */
export function parseNativeOnceControlReference(
  value: unknown,
): NativeScheduleControlReference {
  const ref = parseNativeScheduleControlReference(value);
  if (ref.profileId !== 'allrice-once-control-v1') return invalid();
  return ref;
}

/** Private test seams only; deployment settings cannot supply functions/URLs. */
export interface NativeOnceLoaderTestPorts {
  currentArtifact?: () => ApprovedDshNativeControlArtifact;
  resolveModule?: (from: string, specifier: string) => string;
  realpath?: typeof realpath;
  lstat?: typeof lstat;
  readFile?: typeof readFile;
  importModule?: (path: string) => Promise<Record<string, unknown>>;
}

/** Every public package and the private carrier come from this release's
 * verified primary root. The reference's artifactId records where the partition
 * was born and never selects code (MET-221); its bytes stay unchanged. There is
 * no current-directory or alternate-root retry. */
export function createNativeOnceControlSource(
  reference: NativeScheduleControlReference,
  testPorts: NativeOnceLoaderTestPorts = {},
): NativeScheduleControlSource {
  const ref = parseNativeScheduleControlReference(reference);
  const artifact = (
    testPorts.currentArtifact ?? currentDshNativeControlArtifact
  )();
  if (
    artifact.generation !== DSH_INSTALLED_DISTRIBUTION.generation ||
    !isAbsolute(artifact.root) ||
    resolve(artifact.root) !== artifact.root
  )
    return invalid();
  const factory = join(artifact.root, FACTORY);
  const factoryFact = artifact.content.files.find((f) => f.path === FACTORY);
  if (!factoryFact) return invalid();
  const actualPath = testPorts.realpath ?? realpath;
  const stat = testPorts.lstat ?? lstat;
  const bytes = testPorts.readFile ?? readFile;
  const resolveModule =
    testPorts.resolveModule ??
    ((from, name) => createRequire(from).resolve(name));
  const importModule =
    testPorts.importModule ?? ((path) => import(pathToFileURL(path).href));
  let checkedFactory: Promise<void> | undefined;
  const verifyFactory = () =>
    (checkedFactory ??= (async () => {
      const s = await stat(factory);
      if (
        !s.isFile() ||
        s.isSymbolicLink() ||
        s.size !== factoryFact.bytes ||
        (await actualPath(factory)) !== factory
      )
        return invalid();
      if (
        'sha256:' +
          createHash('sha256')
            .update(await bytes(factory))
            .digest('hex') !==
        factoryFact.checksum
      )
        return invalid();
    })());
  // Only execute the already measured factory after its exact bytes pass.
  // v2 consumes the same literal mapping that the native verifier measured.
  let factoryModule: Promise<Record<string, unknown>> | undefined;
  const loadFactory = () =>
    (factoryModule ??= (async () => {
      await verifyFactory();
      return importModule(factory);
    })());
  type ModuleSelection = {
    specifier: string;
    anchor: 'factory' | 'controller';
  };
  const selectedModuleMap = async (): Promise<
    Record<string, ModuleSelection>
  > => {
    if (artifact.content.schemaVersion === 1)
      return Object.fromEntries(
        Object.entries(moduleNames).map(([key, name]) => [
          key,
          {
            specifier: '@deepseek-ai/' + name,
            anchor: ['commands', 'connection'].includes(key)
              ? 'controller'
              : 'factory',
          },
        ]),
      );
    if (artifact.content.schemaVersion !== 2) return invalid();
    const value = (await loadFactory()).nativeScheduleModuleMap;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const entries = Object.entries(Object.getOwnPropertyDescriptors(value));
    if (
      Reflect.ownKeys(value).length !== entries.length ||
      entries.length !== Object.keys(moduleNames).length ||
      entries.some(
        ([key, descriptor]) =>
          !Object.hasOwn(moduleNames, key) ||
          !descriptor.enumerable ||
          !('value' in descriptor),
      )
    )
      return invalid();
    const result: Record<string, ModuleSelection> = {};
    for (const [key, descriptor] of entries) {
      const item = descriptor.value;
      if (
        !item ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        Object.getPrototypeOf(item) !== Object.prototype ||
        Reflect.ownKeys(item).length !== 2
      )
        return invalid();
      const fields = Object.getOwnPropertyDescriptors(item);
      if (
        !fields.specifier?.enumerable ||
        !('value' in fields.specifier) ||
        !fields.anchor?.enumerable ||
        !('value' in fields.anchor)
      )
        return invalid();
      const specifier = fields.specifier.value,
        anchor = fields.anchor.value;
      if (
        specifier !==
          '@deepseek-ai/' + moduleNames[key as keyof typeof moduleNames] ||
        anchor !==
          (['commands', 'connection'].includes(key) ? 'controller' : 'factory')
      )
        return invalid();
      result[key] = { specifier, anchor };
    }
    return result;
  };
  let modules: Promise<NativeSchedulePublicModules> | undefined;
  let host:
    ReturnType<NativeScheduleControlSource['loadHostFactory']> | undefined;
  return {
    reference: ref,
    loadModules() {
      modules ??= (async () => {
        await verifyFactory();
        const mapping = await selectedModuleMap();
        const controller = await actualPath(
          resolveModule(factory, mapping.controller!.specifier),
        );
        const cordis = await actualPath(
          resolveModule(factory, mapping.cordis!.specifier),
        );
        const selected: Array<[string, string]> = [];
        for (const [key, { specifier, anchor }] of Object.entries(mapping)) {
          const path = await actualPath(
            resolveModule(
              anchor === 'controller' ? controller : factory,
              specifier,
            ),
          );
          const approved = artifact.content.packages.find(
            (p) =>
              p.name === specifier &&
              path.startsWith(join(artifact.root, p.path) + sep),
          );
          if (
            !approved ||
            approved.version !== (key === 'cordis' ? '4.0.5' : '0.2.1-rc.2') ||
            !path.startsWith(artifact.root + sep) ||
            (await actualPath(resolveModule(path, '@deepseek-ai/cordis'))) !==
              cordis
          )
            return invalid();
          selected.push([key, path]);
        }
        return Object.fromEntries(
          await Promise.all(
            selected.map(async ([key, path]) => [
              key,
              await importModule(path),
            ]),
          ),
        ) as unknown as NativeSchedulePublicModules;
      })();
      return modules;
    },
    loadHostFactory() {
      host ??= (async () => {
        const loaded = await loadFactory();
        if (typeof loaded.openNativeScheduleControlHost !== 'function')
          return invalid();
        return loaded.openNativeScheduleControlHost as Awaited<
          ReturnType<NativeScheduleControlSource['loadHostFactory']>
        >;
      })();
      return host;
    },
  };
}

export function configuredNativeOnceControlSource(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  testPorts: NativeOnceLoaderTestPorts = {},
) {
  if (environment.ALLRICE_NATIVE_ONCE_ENABLED !== '1') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(environment.ALLRICE_NATIVE_ONCE_REFERENCE ?? 'null');
  } catch {
    return invalid();
  }
  return createNativeOnceControlSource(
    parseNativeOnceControlReference(raw),
    testPorts,
  );
}

export function configuredNativeRecurringControlSource(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  testPorts: NativeOnceLoaderTestPorts = {},
) {
  if (environment.ALLRICE_NATIVE_RECURRING_ENABLED !== '1') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(environment.ALLRICE_NATIVE_RECURRING_REFERENCE ?? 'null');
  } catch {
    return invalid();
  }
  const reference = parseNativeScheduleControlReference(raw);
  if (reference.profileId !== 'allrice-recurring-control-v1') return invalid();
  return createNativeOnceControlSource(reference, testPorts);
}

/** Retirement/readback only: metadata through this exact artifact's public
 * JSONL reader. This opens no Host, Agent, model, business pin, or writer. */
export async function verifyNativeOnceControlHistory(
  reference: NativeScheduleControlReference,
  controls: readonly {
    controlSessionId: string;
    sessionState: 'reserved' | 'initializing' | 'ready';
  }[],
) {
  const source = createNativeOnceControlSource(reference);
  const m = await source.loadModules();
  const ctx = new m.cordis.Context();
  const reader = ctx.plugin(m.jsonl, {
    root: join(source.reference.stateRoot, 'sessions'),
    compression: 'none',
  });
  let verified = 0;
  try {
    await reader.await();
    const persistence = ctx.get('sessionPersistence') as SessionPersistence;
    const signal = AbortSignal.timeout(30_000);
    for (const control of controls) {
      if (
        typeof control.controlSessionId !== 'string' ||
        !control.controlSessionId ||
        Buffer.byteLength(control.controlSessionId) > 64 ||
        !['reserved', 'initializing', 'ready'].includes(control.sessionState)
      )
        return invalid();
      if (control.sessionState === 'reserved') continue;
      const id = m.sessions.SessionId(control.controlSessionId);
      const stored = await persistence.stat(id, { signal });
      if (!stored || stored.header.id !== id)
        throw new NativeScheduleOnceError('history_missing');
      verified++;
    }
    return verified;
  } finally {
    await reader.dispose();
  }
}

type Maintenance = { state: 'open' | 'requested' | 'quiesced' } | null;
type Runtime = Pick<
  ReturnType<typeof createNativeOnceWorkerRuntime>,
  'tick' | 'stop' | 'status'
>;

/** Once shutdown/maintenance is observed this process never reopens the Host.
 * Restart uses the same persisted tuple and the existing cold-recovery path. */
export function createNativeOnceWorkerService(
  input: {
    workerId: string;
    source: NativeScheduleControlSource | null;
    readMaintenance: () => Promise<Maintenance>;
  },
  testPorts: {
    createRuntime?: (
      options: Parameters<typeof createNativeOnceWorkerRuntime>[0],
    ) => Runtime;
  } = {},
) {
  const runtime = input.source
    ? (testPorts.createRuntime ?? createNativeOnceWorkerRuntime)({
        workerId: input.workerId,
        reference: input.source.reference,
        loadModules: () => input.source!.loadModules(),
        loadHostFactory: () => input.source!.loadHostFactory(),
        enabled: true,
      })
    : null;
  let stopped = false,
    stopping: Promise<void> | undefined;
  const stop = () => {
    stopped = true;
    stopping ??= Promise.resolve(runtime?.stop());
    return stopping;
  };
  const observeMaintenance = async (maintenance: Maintenance) => {
    if (!runtime || stopped) return false;
    if (maintenance && maintenance.state !== 'open') {
      await stop();
      return false;
    }
    return !stopped;
  };
  const admissionOpen = async () => {
    if (!runtime || stopped) return false;
    try {
      return await observeMaintenance(await input.readMaintenance());
    } catch {
      await stop();
      throw new NativeScheduleOnceError('closed');
    }
  };
  return {
    enabled: !!runtime,
    observeMaintenance,
    admissionOpen,
    stop,
    async tick() {
      if ((await admissionOpen()) && !stopped) await runtime!.tick();
    },
    status() {
      return runtime?.status() ?? { state: 'disabled' as const };
    },
  };
}
