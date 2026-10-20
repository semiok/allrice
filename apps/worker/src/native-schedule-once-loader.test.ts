import { createHash } from 'node:crypto';
import type * as NativeFs from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configuredNativeOnceControlSource,
  createNativeOnceControlSource,
  createNativeOnceWorkerService,
  parseNativeOnceControlReference,
  type NativeOnceLoaderTestPorts,
} from './native-schedule-once-loader.js';
import type { ApprovedDshNativeControlArtifact } from './harness/dsh-native-artifact.js';
import type { NativeScheduleControlReference } from './native-schedule-once.js';
import type { NativeOnceWorkerRuntimeOptions } from './native-schedule-once-runtime.js';
import type { RiceToolExecutionInput } from './tool-broker/types.js';
import { createAutomation } from './tool-broker/handlers/automation.js';

const db = vi.hoisted(() => ({ createOnceTaskFromExecutionContext: vi.fn() }));
vi.mock('@allrice/database', () => db);
beforeEach(() => vi.clearAllMocks());
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function loaderFixture() {
  const root = '/verified/release',
    factory = root + '/apps/worker/dsh/native-schedule-host-factory.mjs';
  const bytes = Buffer.from('synthetic approved factory bytes');
  const reference: NativeScheduleControlReference = {
    artifactId: 'sha256:' + 'a'.repeat(64),
    profileId: 'allrice-once-control-v1',
    storageId: 'once-storage',
    stateRoot: '/approved/once-state',
  };
  const names = [
    'cordis',
    'dsh-llm',
    'dsh-session',
    'dsh-session-projection',
    'dsh-system-prompt',
    'dsh-fs-local',
    'dsh-working-directory',
    'dsh-tools',
    'dsh-agent',
    'dsh-agent-loop',
    'dsh-session-persistence-jsonl',
    'dsh-storage',
    'dsh-storage-domain',
    'dsh-workspace',
    'dsh-typert-registry',
    'dsh-agent-default-model',
    'dsh-credentials',
    'dsh-commands',
    'dsh-client-connection',
    'dsh-attachment-local',
    'dsh-client-file-upload',
    'dsh-session-query-sqlite',
    'dsh-api-session-controller',
    'dsh-sdk-jsonrpc-server',
    'dsh-schedule',
  ];
  const artifact: ApprovedDshNativeControlArtifact = {
    artifactId: reference.artifactId,
    generation: 'dsh-0.2.1-rc.2-687f282',
    root,
    content: {
      files: [
        {
          path: factory.slice(root.length + 1),
          bytes: bytes.length,
          checksum:
            'sha256:' + createHash('sha256').update(bytes).digest('hex'),
        },
      ],
      packages: names.map((name) => ({
        path: 'packages/' + name,
        name: '@deepseek-ai/' + name,
        version: name === 'cordis' ? '4.0.5' : '0.2.1-rc.2',
        files: 1,
        bytes: 1,
        checksum: 'sha256:' + 'b'.repeat(64),
      })),
    },
  };
  const open = vi.fn();
  const imports = vi.fn(
    async (path: string): Promise<Record<string, unknown>> =>
      path === factory ? { openNativeScheduleControlHost: open } : { path },
  );
  const resolveModule = vi.fn(
    (_from: string, name: string) =>
      root + '/packages/' + name.split('/')[1] + '/index.js',
  );
  const ports: NativeOnceLoaderTestPorts = {
    approvedArtifact: vi.fn(() => artifact),
    resolveModule,
    realpath: vi.fn(
      async (path: string) => path,
    ) as unknown as typeof NativeFs.realpath,
    lstat: vi.fn(async () => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      size: bytes.length,
    })) as unknown as typeof NativeFs.lstat,
    readFile: vi.fn(async () => bytes) as unknown as typeof NativeFs.readFile,
    importModule: imports,
  };
  return {
    root,
    factory,
    reference,
    artifact,
    ports,
    imports,
    open,
    resolveModule,
  };
}

describe('approved native once loader', () => {
  it('disabled does not parse settings or query/load an artifact', () => {
    const f = loaderFixture();
    expect(
      configuredNativeOnceControlSource(
        { ALLRICE_NATIVE_ONCE_REFERENCE: 'invalid JSON' },
        f.ports,
      ),
    ).toBeNull();
    expect(f.ports.approvedArtifact).not.toHaveBeenCalled();
    expect(f.imports).not.toHaveBeenCalled();
  });
  it.each(['profile', 'extra', 'relative', 'id'] as const)(
    'rejects %s reference mismatch before loading code',
    (kind) => {
      const f = loaderFixture(),
        ref = { ...f.reference };
      const value =
        kind === 'profile'
          ? { ...ref, profileId: 'restricted' }
          : kind === 'extra'
            ? { ...ref, moduleUrl: 'https://unapproved.invalid' }
            : kind === 'relative'
              ? { ...ref, stateRoot: './state' }
              : { ...ref, artifactId: 'self-claimed' };
      expect(() => parseNativeOnceControlReference(value)).toThrow(
        'BINDING_INVALID',
      );
      expect(f.imports).not.toHaveBeenCalled();
    },
  );
  it('loads only measured current packages, one Cordis instance and the fixed factory, once', async () => {
    const f = loaderFixture(),
      source = createNativeOnceControlSource(f.reference, f.ports);
    const first = source.loadModules();
    expect(source.loadModules()).toBe(first);
    const loaded = await first;
    expect(Object.keys(loaded)).toHaveLength(25);
    const host = source.loadHostFactory();
    expect(source.loadHostFactory()).toBe(host);
    expect(await host).toBe(f.open);
    expect(f.imports).toHaveBeenCalledTimes(26);
    expect(
      f.imports.mock.calls.every(([path]) => path.startsWith(f.root + '/')),
    ).toBe(true);
    expect(f.resolveModule).toHaveBeenCalledWith(
      f.root + '/packages/dsh-api-session-controller/index.js',
      '@deepseek-ai/dsh-commands',
    );
    expect(f.ports.approvedArtifact).toHaveBeenCalledWith(
      f.reference.artifactId,
    );
    expect(source.reference).toEqual(f.reference);
    expect(Object.isFrozen(source.reference)).toBe(true);
  });
  it.each([
    'generation',
    'missing factory',
    'old package',
    'foreign package',
    'Cordis split',
  ] as const)('refuses %s without importing a fallback', async (kind) => {
    const f = loaderFixture();
    if (kind === 'generation') f.artifact.generation = 'dsh-0.1.5-rc.3-a4c74a9';
    if (kind === 'missing factory') f.artifact.content.files = [];
    if (kind === 'old package')
      f.artifact.content.packages.find(
        (p) => p.name === '@deepseek-ai/dsh-schedule',
      )!.version = '0.1.5-rc.3';
    if (kind === 'foreign package')
      f.resolveModule.mockImplementation((_from, name) =>
        name === '@deepseek-ai/dsh-schedule'
          ? '/unapproved/schedule/index.js'
          : f.root + '/packages/' + name.split('/')[1] + '/index.js',
      );
    if (kind === 'Cordis split')
      f.resolveModule.mockImplementation((from, name) =>
        from.includes('/dsh-schedule/') && name === '@deepseek-ai/cordis'
          ? f.root + '/different-peer/cordis.js'
          : f.root + '/packages/' + name.split('/')[1] + '/index.js',
      );
    if (['generation', 'missing factory'].includes(kind))
      expect(() => createNativeOnceControlSource(f.reference, f.ports)).toThrow(
        'BINDING_INVALID',
      );
    else
      await expect(
        createNativeOnceControlSource(f.reference, f.ports).loadModules(),
      ).rejects.toMatchObject({ code: 'binding_invalid' });
    expect(f.imports).not.toHaveBeenCalled();
  });
  it('rejects changed factory bytes and retains the same failed load promise', async () => {
    const f = loaderFixture();
    f.artifact.content.files[0]!.checksum = 'sha256:' + '0'.repeat(64);
    const source = createNativeOnceControlSource(f.reference, f.ports),
      first = source.loadHostFactory();
    expect(source.loadHostFactory()).toBe(first);
    await expect(first).rejects.toMatchObject({ code: 'binding_invalid' });
    expect(f.imports).not.toHaveBeenCalled();
  });
});

describe('native once Worker maintenance and stop boundary', () => {
  it('feature off touches no maintenance reader or runtime', async () => {
    const readMaintenance = vi.fn(),
      createRuntime = vi.fn();
    const service = createNativeOnceWorkerService(
      { source: null, workerId: 'w', readMaintenance },
      { createRuntime },
    );
    await service.tick();
    await service.stop();
    expect(readMaintenance).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
    expect(service.status().state).toBe('disabled');
  });
  it('waits for stop/drain on maintenance closure, never automatically reopens, and a restart retains the reference', async () => {
    const f = loaderFixture(),
      source = createNativeOnceControlSource(f.reference, f.ports),
      gate = deferred();
    let maintenance: { state: 'open' | 'requested' } = { state: 'open' },
      state = 'active';
    const runtime = {
      tick: vi.fn(async () => undefined),
      stop: vi.fn(async () => {
        await gate.promise;
        state = 'closed';
      }),
      status: () => ({ state }),
    };
    const createRuntime = vi.fn<
      (options: NativeOnceWorkerRuntimeOptions) => never
    >(() => runtime as never);
    const service = createNativeOnceWorkerService(
      { source, workerId: 'w', readMaintenance: async () => maintenance },
      { createRuntime },
    );
    await service.tick();
    expect(runtime.tick).toHaveBeenCalledTimes(1);
    maintenance = { state: 'requested' };
    let completed = false;
    const closing = service.admissionOpen().then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(runtime.stop).toHaveBeenCalledTimes(1));
    expect(completed).toBe(false);
    const stop = service.stop();
    expect(service.stop()).toBe(stop);
    gate.resolve();
    await closing;
    await stop;
    maintenance = { state: 'open' };
    await service.tick();
    expect(runtime.tick).toHaveBeenCalledTimes(1);
    expect(createRuntime).toHaveBeenCalledTimes(1);
    const restarted = createNativeOnceWorkerService(
      { source, workerId: 'w2', readMaintenance: async () => maintenance },
      { createRuntime },
    );
    expect(createRuntime.mock.calls[1]![0].reference).toEqual(f.reference);
    await restarted.stop();
  });
  it('stops on an unknown maintenance read and prevents subsequent ticks', async () => {
    const f = loaderFixture(),
      source = createNativeOnceControlSource(f.reference, f.ports);
    const runtime = {
      tick: vi.fn(),
      stop: vi.fn(async () => undefined),
      status: () => ({ state: 'closed' }),
    };
    const service = createNativeOnceWorkerService(
      {
        source,
        workerId: 'w',
        readMaintenance: async () => {
          throw Error('unknown barrier read');
        },
      },
      { createRuntime: () => runtime as never },
    );
    await expect(service.tick()).rejects.toMatchObject({ code: 'closed' });
    await service.tick();
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(runtime.tick).not.toHaveBeenCalled();
  });
});

function toolInput(): RiceToolExecutionInput {
  return {
    context: { runId: 'synthetic-run' } as RiceToolExecutionInput['context'],
    capabilities: [],
    storageRoot: '/synthetic',
    sessionId: 'synthetic-session',
    userMessageId: 'synthetic-message',
    managedBrowserJobAttempt: 3,
    managedBrowserJobLeaseToken: 'synthetic-job-token',
    call: {
      id: 'synthetic-native-call',
      name: 'automation.create',
      arguments: {},
    },
  };
}
describe('existing automation.create enrollment', () => {
  it('passes exact execution/call/message and real Worker lease fields to the once API', async () => {
    const input = toolInput(),
      args = { name: 'once', prompt: 'work', delayMinutes: 5 };
    db.createOnceTaskFromExecutionContext.mockResolvedValueOnce({
      id: 'task',
      name: 'once',
      runAt: '2030-01-01T00:00:00.000Z',
      sessionId: input.sessionId,
      status: 'preparing',
    });
    const result = await createAutomation({ input, arguments: args });
    const sent = db.createOnceTaskFromExecutionContext.mock.calls[0]![0];
    expect(sent.context).toBe(input.context);
    expect(sent).toMatchObject({
      sessionId: input.sessionId,
      userMessageId: input.userMessageId,
      callId: input.call.id,
      arguments: args,
      worker: { attempt: 3, leaseToken: input.managedBrowserJobLeaseToken },
    });
    expect(sent).not.toHaveProperty('actor');
    expect(sent).not.toHaveProperty('memberships');
    expect(JSON.parse(result.modelContent)).toMatchObject({
      automationId: 'task',
      status: 'preparing',
      sessionId: input.sessionId,
    });
  });
  it('model arguments cannot supply a missing private Job lease or chat context', async () => {
    const input = toolInput();
    delete input.managedBrowserJobLeaseToken;
    await expect(
      createAutomation({
        input,
        arguments: {
          name: 'once',
          prompt: 'work',
          delayMinutes: 5,
          sessionId: 'forged',
          userMessageId: 'forged',
          worker: { attempt: 3, leaseToken: 'forged' },
        },
      }),
    ).rejects.toMatchObject({ code: 'AUTOMATION_UNAVAILABLE' });
    expect(db.createOnceTaskFromExecutionContext).not.toHaveBeenCalled();
  });
});
