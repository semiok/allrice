import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DshProtocolClient } from '../dsh-protocol-client.js';
import { DshHarnessAdapter, controlDshInputDelivery } from '../dsh-adapter.js';
import { DshRuntimePool, type DshRuntime } from './runtime-pool.js';
import {
  createConversationInputDelivery,
  pollEmployeeConversationSteers,
} from '../../conversation/turn-lifecycle.js';
import { HandlerError } from '../../errors.js';

const db = vi.hoisted(() => ({
  claim: vi.fn(),
  consume: vi.fn(),
  defer: vi.fn(),
  reject: vi.fn(),
}));
vi.mock('@allrice/database', () => {
  const values: Record<string | symbol, unknown> = {
    claimConversationSteer: db.claim,
    consumeConversationSteer: db.consume,
    deferConversationSteer: db.defer,
    rejectConversationSteer: db.reject,
    bindConversationThread: vi.fn(),
    recordConversationTurn: vi.fn(),
    AssistantRuntimeError: class extends Error {},
  };
  return new Proxy(values, {
    has: () => true,
    get(target, name) {
      if (name === 'then') return undefined;
      return (target[name] ??= () => {
        throw Error('DATABASE_ACCESS_FORBIDDEN_IN_FIXTURE');
      });
    },
  });
});
const roots: string[] = [],
  pools: DshRuntimePool[] = [];
const stops: (() => void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
  for (const mock of Object.values(db)) mock.mockReset();
  vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function runtime(
  client: DshProtocolClient,
  id = 'native-input-gate',
): DshRuntime {
  return {
    client,
    id: randomUUID(),
    sessionId: id,
    fingerprint: 'fixture',
    fingerprintParts: {},
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    productSessionId: randomUUID(),
    ownerId: randomUUID(),
    providerRoute: 'offline-input-gate',
    model: 'fixed-local-data',
    reasoningEffort: 'none',
    nativeTools: [],
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
  };
}
function attach(pool: DshRuntimePool, state: DshRuntime) {
  // Test-owned incarnation only; no production pool/process is accessed.
  (pool as unknown as { runtimes: Map<string, DshRuntime> }).runtimes.set(
    state.sessionId,
    state,
  );
}
function privateRequest(
  client: DshProtocolClient,
  method: string,
  params: Record<string, unknown> = {},
) {
  return (
    client as unknown as {
      request(
        method: string,
        params: Record<string, unknown>,
      ): Promise<Record<string, unknown>>;
    }
  ).request(method, params);
}

it.each([
  [{ code: -32603, message: 'ASSISTANT_COMPLETING' }, 'ASSISTANT_COMPLETING'],
  [
    { code: -32603, message: 'prefix ASSISTANT_COMPLETING' },
    'DSH_REQUEST_FAILED',
  ],
  [
    { code: -32603, message: 'ASSISTANT_COMPLETING', data: { code: 'OTHER' } },
    'DSH_REQUEST_FAILED',
  ],
  [
    { code: -32603, message: 'other', data: { code: 'ASSISTANT_COMPLETING' } },
    'ASSISTANT_COMPLETING',
  ],
])(
  'maps only the exact native completion error (%s)',
  async (error, expected) => {
    const client = Object.create(
      DshProtocolClient.prototype,
    ) as DshProtocolClient;
    const result = new Promise((resolve, reject) => {
      Object.assign(client, {
        pending: new Map([[1, { resolve, reject, timer: undefined }]]),
      });
    });
    const refusal = expect(result).rejects.toMatchObject({ code: expected });
    (client as unknown as { handleLine(line: string): void }).handleLine(
      JSON.stringify({ id: 1, error }),
    );
    await refusal;
  },
);

it.each([true, false])(
  'waits for in-flight RPC and only accepts a known pre-insertion refusal (safe=%s)',
  async (safe) => {
    const work = deferred<Record<string, unknown>>();
    let reject!: (reason: unknown) => void;
    const rpc = new Promise<Record<string, unknown>>((resolve, failed) => {
      reject = failed;
      void work.promise.then(resolve);
    });
    const client = {
      steer: vi.fn(() => rpc),
      close: async () => {},
    } as unknown as DshProtocolClient;
    const pool = new DshRuntimePool({
      credentialResolver: { resolve: async () => ({ apiKey: 'synthetic' }) },
    });
    pools.push(pool);
    const state = runtime(client);
    attach(pool, state);
    const turnId = `${state.sessionId}:turn:1`,
      runId = randomUUID(),
      gateId = randomUUID();
    const controller = createConversationInputDelivery({
      threadId: state.sessionId,
      turnId,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 60_000,
      isCurrent: () => true,
      handoff: async () => {},
    });
    stops.push(() => controller.dispose());
    const heldRpc = pool.steer(state.sessionId, 'original', undefined, turnId);
    pool.clearInputDelivery(state); // cleanup must not forget an unresolved RPC
    const rejectedRpc = expect(heldRpc).rejects.toThrow(
      safe ? 'ASSISTANT_COMPLETING' : 'DSH_REQUEST_TIMEOUT',
    );
    const authority = vi.fn(async () => ({ instances: [] }));
    const args = {
      pool,
      runtime: state,
      runId,
      params: { nativeSessionId: state.sessionId, runId, turnId, gateId },
      delivery: controller,
      signal: new AbortController().signal,
      turnId: () => turnId,
      checkContent: async () => {},
      assistant: { cancellation: authority },
    };
    let acked = false;
    const paused = controlDshInputDelivery({
      ...args,
      operation: 'pause',
    }).then((value) => {
      acked = true;
      return value;
    });
    const outcome = safe
      ? expect(paused).resolves.toMatchObject({ paused: true, gateId })
      : expect(paused).rejects.toThrow('INPUT_GATE_NOT_QUIESCENT');
    await Promise.resolve();
    expect(acked).toBe(false);
    await expect(
      pool.steer(state.sessionId, 'later', undefined, turnId),
    ).rejects.toMatchObject({ code: 'ASSISTANT_COMPLETING' });
    reject(
      new HandlerError(
        safe ? 'ASSISTANT_COMPLETING' : 'DSH_REQUEST_TIMEOUT',
        safe ? 'ASSISTANT_COMPLETING' : 'DSH_REQUEST_TIMEOUT',
        false,
      ),
    );
    await rejectedRpc;
    await outcome;
    expect(authority).toHaveBeenCalledTimes(safe ? 1 : 0);
    await controlDshInputDelivery({ ...args, operation: 'release' });
    expect(controller.paused()).toBe(false);
  },
);

it('fences the exact incarnation/turn/token and always frees the hold on failed release', async () => {
  const pool = new DshRuntimePool();
  pools.push(pool);
  const state = runtime({
    close: async () => {},
  } as unknown as DshProtocolClient);
  attach(pool, state);
  const turnId = `${state.sessionId}:turn:1`,
    runId = randomUUID(),
    gateId = randomUUID();
  const dispose = vi.fn(),
    handoff = vi.fn(async () => {
      throw Error('lease lost');
    });
  const pause = vi.fn(() => ({
    settled: Promise.resolve(),
    current: () => true,
    resumeBeforeTurnClose: handoff,
    dispose,
  }));
  const args = {
    pool,
    runtime: state,
    runId,
    params: { nativeSessionId: state.sessionId, runId, turnId, gateId },
    delivery: { pause },
    signal: new AbortController().signal,
    turnId: () => turnId,
    checkContent: async () => {},
    assistant: { cancellation: async () => ({ instances: [] }) },
  };
  await expect(
    controlDshInputDelivery({
      ...args,
      params: { ...args.params, turnId: 'wrong-turn' },
      operation: 'pause',
    }),
  ).rejects.toThrow('INPUT_GATE_SCOPE_CHANGED');
  expect(pause).not.toHaveBeenCalled();
  await controlDshInputDelivery({ ...args, operation: 'pause' });
  await controlDshInputDelivery({ ...args, operation: 'pause' });
  expect(pause).toHaveBeenCalledTimes(1);
  await expect(
    controlDshInputDelivery({
      ...args,
      params: { ...args.params, gateId: randomUUID() },
      operation: 'release',
    }),
  ).rejects.toThrow('INPUT_GATE_SCOPE_CHANGED');
  await expect(
    controlDshInputDelivery({ ...args, operation: 'release' }),
  ).rejects.toThrow('lease lost');
  await expect(
    controlDshInputDelivery({ ...args, operation: 'release' }),
  ).rejects.toThrow('lease lost');
  expect(handoff).toHaveBeenCalledTimes(1);
  expect(dispose).toHaveBeenCalledTimes(1);
});

it('runs one real rc.2 SDK and JSON-RPC window through fixed host repair and same-turn human adoption', async () => {
  const prepared = process.env.MET184_INPUT_GATE_PREPARED;
  const root = await mkdtemp(join(tmpdir(), 'allrice-input-gate-sdk-'));
  roots.push(root);
  const id = `input-gate-${randomUUID()}`,
    runId = randomUUID(),
    turnId = `${id}:turn:1`;
  const client = new DshProtocolClient({
    command: process.execPath,
    args: [
      '--import',
      resolve(
        import.meta.dirname,
        '../../../test/fixtures/native-input-gate-network-guard.mjs',
      ),
      ...(prepared ? ['--import', join(prepared, 'test-loader.mjs')] : []),
      resolve(
        import.meta.dirname,
        '../../../test/fixtures/native-input-gate-child.mjs',
      ),
    ],
    cwd: root,
    environment: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      MET184_INPUT_FIXTURE_ROOT: root,
    },
    requestTimeoutMs: 10_000,
  });
  const adapter = new DshHarnessAdapter({
    runtimeRoot: root,
    credentialResolver: { resolve: async () => ({ apiKey: 'synthetic-only' }) },
  });
  const pool = (adapter as unknown as { runtimePool: DshRuntimePool })
    .runtimePool;
  pools.push(pool);
  const state = runtime(client, id);
  attach(pool, state);
  const abort = new AbortController();
  let polling = true,
    currentTurn = turnId;
  const owner = {
    organizationId: state.organizationId,
    workspaceId: state.workspaceId,
    sessionId: state.productSessionId!,
    runId,
    workerId: randomUUID(),
  };
  const command = {
    id: randomUUID(),
    followupRunId: randomUUID(),
    clientUserMessageId: randomUUID(),
    message: 'The unchanged late human correction',
    inputKind: 'steer_current' as const,
  };
  let pending = false,
    consumed = false,
    claimed = false,
    nextAttemptAt = 0;
  db.claim.mockImplementation(async (request: { drain?: boolean }) => {
    if (
      !pending ||
      consumed ||
      claimed ||
      (!request.drain && Date.now() < nextAttemptAt)
    )
      return null;
    claimed = true;
    return command;
  });
  db.defer.mockImplementation(async () => {
    claimed = false;
    // Match the existing durable table's deferConversationSteer 500ms boundary.
    nextAttemptAt = Date.now() + 500;
  });
  db.consume.mockImplementation(async () => {
    consumed = true;
    claimed = false;
  });
  const controller: ReturnType<typeof createConversationInputDelivery> =
    createConversationInputDelivery({
      threadId: id,
      turnId,
      signal: abort.signal,
      deadlineAt: Date.now() + 60_000,
      isCurrent: () => polling && currentTurn === turnId,
      handoff: () =>
        pollEmployeeConversationSteers({
          ownership: owner,
          generation: 7,
          threadId: id,
          turnId,
          signal: abort.signal,
          adapter,
          polling: () => false,
          drain: true,
          handoff: true,
          delivery: controller,
        }),
    });
  stops.push(() => {
    polling = false;
    abort.abort();
    controller.dispose();
  });
  const paused = deferred<Record<string, unknown>>(),
    repaired = deferred<void>(),
    released = deferred<void>();
  client.subscribe((frame) => {
    if (frame.method === 'fixture.paused') paused.resolve(frame.params);
    if (frame.method === 'fixture.repair-reply') repaired.resolve();
    if (frame.method === 'fixture.released') released.resolve();
    if (frame.method === 'fixture.turn')
      currentTurn = String(frame.params.turnId);
  });
  const authority = vi.fn(async () => ({ instances: [] }));
  const actions: string[] = [];
  client.setRequestHandler(async (method, params) => {
    actions.push(method);
    if (
      method === 'allrice/assistant/input-gate-pause' ||
      method === 'allrice/assistant/input-gate-release'
    )
      return controlDshInputDelivery({
        pool,
        runtime: state,
        operation: method.endsWith('pause') ? 'pause' : 'release',
        params,
        runId,
        delivery: controller,
        signal: abort.signal,
        turnId: () => currentTurn,
        checkContent: async () => {},
        assistant: { cancellation: authority },
      });
    if (method === 'allrice/assistant/model-prepare')
      return { prepared: true, outputTokens: params.outputTokens };
    if (method === 'allrice/assistant/model-dispatch')
      return { reserved: true, outputTokens: params.outputTokens };
    if (method === 'allrice/assistant/model-settle') return { settled: true };
    return { recorded: true };
  });
  const loop = pollEmployeeConversationSteers({
    ownership: owner,
    generation: 7,
    threadId: id,
    turnId,
    signal: abort.signal,
    adapter,
    polling: () => polling,
    delivery: controller,
  });
  try {
    await privateRequest(client, 'fixture/start', {
      nativeSessionId: id,
      runId,
    });
    const gate = (await paused.promise).gate as Record<string, unknown>;
    expect(controller.paused()).toBe(true);
    const before = db.claim.mock.calls.length;
    pending = true;
    await new Promise((r) => setTimeout(r, 30));
    expect(db.claim).toHaveBeenCalledTimes(before);
    await expect(
      client.steer(id, 'blocked typed probe', {
        inputId: randomUUID(),
        turnId,
        kind: 'steer_current',
      }),
    ).rejects.toMatchObject({ code: 'ASSISTANT_COMPLETING' });
    await expect(
      client.steer(id, 'blocked legacy probe'),
    ).rejects.toMatchObject({ code: 'ASSISTANT_COMPLETING' });
    expect(
      await privateRequest(client, 'fixture/other-root-open'),
    ).toMatchObject({ open: true });
    await expect(
      client.assistant('joinForFinalDelivery', { nativeSessionId: id }),
    ).rejects.toThrow('INPUT_GATE_NOT_RELEASED');
    await privateRequest(client, 'fixture/continue-repair');
    await repaired.promise;
    expect(controller.paused()).toBe(true);
    expect(db.consume).not.toHaveBeenCalled();
    await privateRequest(client, 'fixture/release-input');
    await released.promise;
    const beforeConsume = await privateRequest(client, 'fixture/snapshot');
    if (prepared)
      await writeFile(
        join(prepared, 'sdk-readback-before-consume.json'),
        JSON.stringify(
          {
            snapshot: beforeConsume,
            claim: db.claim.mock.calls,
            defer: db.defer.mock.calls,
            reject: db.reject.mock.calls,
            consume: db.consume.mock.calls,
            paused: controller.paused(),
            current: controller.current(),
            currentTurn,
          },
          null,
          2,
        ) + '\n',
      );
    await vi.waitFor(() => expect(consumed).toBe(true), { timeout: 5_000 });
    const snapshot = await privateRequest(client, 'fixture/snapshot');
    const events = snapshot.events as {
      seq: number;
      type: string;
      data: {
        inputId?: string;
        messageId?: string;
        turnId?: string;
        id?: string;
        source?: { kind?: string; form?: string };
        content?: unknown;
      };
    }[];
    const human = events.find(
      (e) =>
        e.type === 'allrice/input/request' &&
        e.data.inputId === command.clientUserMessageId,
    )!;
    const adopted = events.find(
      (e) => e.type === 'user/message' && e.data.id === human.data.messageId,
    )!;
    expect(human.data.turnId).toBe(turnId);
    expect(adopted.data.source?.kind).toBe('user');
    expect(adopted.data.content).toEqual([
      { type: 'text', text: command.message },
    ]);
    const host = events.find(
      (e) =>
        e.type === 'user/message' &&
        e.data.source?.kind === 'allrice-final-delivery-repair',
    )!;
    expect(host.data.source?.form).toBe('notice');
    expect(host.seq).toBeLessThan(adopted.seq);
    expect(events.filter((e) => e.type === 'turn/start')).toHaveLength(1);
    expect(snapshot.steps).toBe(3);
    expect(snapshot.errors).toEqual([]);
    expect(snapshot.networkAttempts).toBe(0);
    expect(db.reject).not.toHaveBeenCalled();
    expect(db.consume).toHaveBeenCalledTimes(1);
    expect(db.consume).toHaveBeenCalledWith({
      commandId: command.id,
      workerId: owner.workerId,
      proof: {
        status: 'adopted',
        inputId: command.clientUserMessageId,
        messageId: human.data.messageId,
        sequence: adopted.seq,
        turnId,
        checkpoint: 'step_user_message',
      },
    });
    expect(authority).toHaveBeenCalledTimes(2);
    expect(controller.paused()).toBe(false);
    if (prepared)
      await writeFile(
        join(prepared, 'real-sdk-evidence.json'),
        JSON.stringify(
          {
            sdk: '0.2.1-rc.2',
            workerDatabaseAndAuthority: 'explicit fixtures, no DB connections',
            remoteModelCalls: 0,
            syntheticAdapterSteps: snapshot.steps,
            networkAttempts: snapshot.networkAttempts,
            gate,
            originalCommand: command,
            originalInputRequestEvent: human,
            consumedInputProof: db.consume.mock.calls[0]![0].proof,
            actualPersistedAdoption: adopted,
            hostNotice: host,
            turnStarts: events.filter((e) => e.type === 'turn/start'),
            bridgeActions: actions,
            errors: snapshot.errors,
            events,
          },
          null,
          2,
        ) + '\n',
      );
  } finally {
    polling = false;
    abort.abort();
    controller.dispose();
    await loop;
  }
});
