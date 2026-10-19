import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DshProtocolClient } from '../dsh-protocol-client.js';
import { DshHarnessAdapter, controlDshInputDelivery } from '../dsh-adapter.js';
import type { DshRuntimePool, DshRuntime } from './runtime-pool.js';
import {
  createConversationInputDelivery,
  pollEmployeeConversationSteers,
} from '../../conversation/turn-lifecycle.js';

const db = vi.hoisted(() => ({
  claim: vi.fn(),
  consume: vi.fn(),
  defer: vi.fn(),
  reject: vi.fn(),
}));
vi.mock('@allrice/database', () => {
  const ports: Record<string | symbol, unknown> = {
    claimConversationSteer: db.claim,
    consumeConversationSteer: db.consume,
    deferConversationSteer: db.defer,
    rejectConversationSteer: db.reject,
    AssistantRuntimeError: class extends Error {},
  };
  return new Proxy(ports, {
    has: () => true,
    get(target, name) {
      if (name === 'then') return undefined;
      return (target[name] ??= () => {
        throw Error('DATABASE_ACCESS_FORBIDDEN_IN_FIXTURE');
      });
    },
  });
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const mock of Object.values(db)) mock.mockReset();
});
const digest = (value: string) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
function request<T = Record<string, unknown>>(
  client: DshProtocolClient,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return (
    client as unknown as {
      request(method: string, params: Record<string, unknown>): Promise<T>;
    }
  ).request(method, params);
}
interface NativeMessage {
  id?: string;
  source?: { kind?: string; form?: string };
  content?: { type: string; text?: string; name?: string; isError?: boolean }[];
}
interface NativeEvent {
  type: string;
  seq: number;
  data: {
    turn?: number;
    inputId?: string;
    messageId?: string;
    turnId?: string;
    id?: string;
    source?: NativeMessage['source'];
    content?: NativeMessage['content'];
    message?: NativeMessage;
    [key: string]: unknown;
  };
}
interface Snapshot {
  events: NativeEvent[];
  steps: number;
  preparedRequests: number;
  requests: {
    step: number;
    provider: string;
    model: string;
    maxTokens: number;
    sameOriginalTurnSignal: boolean;
    purpose?: string;
  }[];
  toolBodies: { name: string; turnId: string }[];
  probes: { kind: string; code: string }[];
  controlActions: string[];
  errors: (string | number)[];
  flushError?: { code: string | number; message: string; causes?: string[] };
  networkAttempts: number;
  recoverBodyEntered: number;
}
interface Call {
  callId: string;
  runId: string;
  originalDeadlineAt: number;
  requestedOutputTokens: number;
  outputTokens: number;
  dispatchAttempted: boolean;
  dispatchCommitted: boolean;
  closed: boolean;
  settlement?: Record<string, unknown>;
}
interface Action {
  method: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
}
const text = (event: NativeEvent) =>
  event.data.message?.content
    ?.filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
async function fixture(mode: string) {
  const prepared = process.env.MET184_BOUNDED_REPAIR_PREPARED;
  const root = await mkdtemp(join(tmpdir(), 'allrice-bounded-repair-sdk-'));
  const id = `repair-${randomUUID()}`,
    runId = randomUUID(),
    turnId = `${id}:turn:1`;
  const originalDeadlineAt = Date.now() + 60_000;
  const reference = {
    objectId: randomUUID(),
    versionId: randomUUID(),
    checksum: digest('existing fixture bytes'),
    displayName: 'existing.xlsx',
    downloadUrl: '',
  };
  reference.downloadUrl = `/api/v1/files/${reference.objectId}/download`;
  if (mode === 'operations-tail') reference.displayName = 'metrics.json';
  const invalidText =
    mode === 'empty-response'
      ? ''
      : mode === 'operations-tail'
        ? '原复杂运营尾部：[metrics.json](／api) no incorrect need actual.'
        : '[下载](／api) Original answer remains immutable.';
  const validText =
    mode === 'operations-tail'
      ? invalidText.replace('／api', reference.downloadUrl)
      : `[下载](${reference.downloadUrl})`;
  const client = new DshProtocolClient({
    command: process.execPath,
    args: [
      '--import',
      prepared
        ? join(prepared, 'offline-network-guard.mjs')
        : resolve(
            import.meta.dirname,
            '../../../test/fixtures/native-input-gate-network-guard.mjs',
          ),
      ...(prepared ? ['--import', join(prepared, 'test-loader.mjs')] : []),
      resolve(
        import.meta.dirname,
        '../../../test/fixtures/native-bounded-final-delivery-repair-child.mjs',
      ),
    ],
    cwd: root,
    environment: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      MET184_INPUT_FIXTURE_ROOT: root,
    },
    requestTimeoutMs: 15_000,
  });
  const adapter = new DshHarnessAdapter({
    runtimeRoot: root,
    credentialResolver: { resolve: async () => ({ apiKey: 'synthetic-only' }) },
  });
  const pool = (adapter as unknown as { runtimePool: DshRuntimePool })
    .runtimePool;
  const runtime: DshRuntime = {
    client,
    id: randomUUID(),
    sessionId: id,
    fingerprint: 'fixture',
    fingerprintParts: {},
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    productSessionId: randomUUID(),
    ownerId: randomUUID(),
    providerRoute: 'offline-bounded-repair',
    model: 'static-only',
    reasoningEffort: 'none',
    nativeTools: [],
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
  };
  (pool as unknown as { runtimes: Map<string, DshRuntime> }).runtimes.set(
    id,
    runtime,
  );
  const abort = new AbortController();
  let polling = true,
    currentTurn = turnId,
    pending = false,
    claimed = false,
    consumed = false,
    nextAttemptAt = 0,
    inspectCount = 0;
  const owner = {
    organizationId: runtime.organizationId,
    workspaceId: runtime.workspaceId,
    sessionId: runtime.productSessionId!,
    runId,
    workerId: randomUUID(),
  };
  const command = {
    id: randomUUID(),
    followupRunId: randomUUID(),
    clientUserMessageId: randomUUID(),
    message: 'Original late human input: use the ordinary tool.',
    inputKind: 'steer_current' as const,
  };
  db.claim.mockImplementation(async (input: { drain?: boolean }) => {
    if (
      !pending ||
      consumed ||
      claimed ||
      (!input.drain && Date.now() < nextAttemptAt)
    )
      return null;
    claimed = true;
    return command;
  });
  db.defer.mockImplementation(async () => {
    claimed = false;
    nextAttemptAt = Date.now() + 500;
  });
  db.consume.mockImplementation(async () => {
    consumed = true;
    claimed = false;
  });
  const delivery: ReturnType<typeof createConversationInputDelivery> =
    createConversationInputDelivery({
      threadId: id,
      turnId,
      signal: abort.signal,
      deadlineAt: originalDeadlineAt,
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
          delivery,
        }),
    });
  const streaming = deferred<void>(),
    preparedRequest = deferred<void>();
  client.subscribe((frame) => {
    if (frame.method === 'fixture.turn')
      currentTurn = String(frame.params.turnId);
    if (frame.method === 'fixture.repair-stream') streaming.resolve();
    if (frame.method === 'fixture.prepared-request') preparedRequest.resolve();
  });
  const calls: Call[] = [],
    actions: Action[] = [],
    authorities: Record<string, unknown>[] = [];
  const cancellation = vi.fn(async () => ({ instances: [] }));
  client.setRequestHandler(async (method, params) => {
    const action: Action = { method, params };
    actions.push(action);
    try {
      let result: Record<string, unknown>;
      if (
        method === 'allrice/assistant/input-gate-pause' ||
        method === 'allrice/assistant/input-gate-release'
      )
        result = await controlDshInputDelivery({
          pool,
          runtime,
          operation: method.endsWith('pause') ? 'pause' : 'release',
          params,
          runId,
          delivery,
          signal: abort.signal,
          turnId: () => currentTurn,
          checkContent: async () => {},
          assistant: { cancellation },
        });
      else if (method === 'allrice/assistant/model-prepare') {
        const outputTokens = Math.min(Number(params.outputTokens), 128);
        calls.push({
          callId: String(params.callId),
          runId,
          originalDeadlineAt,
          requestedOutputTokens: Number(params.outputTokens),
          outputTokens,
          dispatchAttempted: false,
          dispatchCommitted: false,
          closed: false,
        });
        result = { prepared: true, outputTokens };
      } else if (method === 'allrice/assistant/model-dispatch') {
        const call = calls.find((value) => value.callId === params.callId)!;
        if (!call || call.closed || call.dispatchAttempted)
          throw Error('FIXTURE_MODEL_ADMISSION_CONFLICT');
        call.dispatchAttempted = true;
        if (calls.length === 2 && mode === 'dispatch-unknown-no-commit')
          throw Error('SYNTHETIC_DISPATCH_ACK_LOST');
        call.dispatchCommitted = true;
        if (calls.length === 2 && mode === 'dispatch-unknown-committed')
          throw Error('SYNTHETIC_DISPATCH_ACK_LOST');
        result = { reserved: true, outputTokens: call.outputTokens };
      } else if (method === 'allrice/assistant/model-settle') {
        const call = calls.find((value) => value.callId === params.callId)!;
        if (!call?.dispatchCommitted)
          throw Error('FIXTURE_SETTLE_REQUIRES_DISPATCH');
        call.settlement = params;
        result = { settled: true };
      } else if (method === 'allrice/assistant/delivery-repair-inspect') {
        const candidate = params.candidate as {
          candidateDigest: string;
          text: string;
        };
        inspectCount++;
        const conflict = mode === 'pre-notice-conflict' && inspectCount === 2;
        if (conflict) pending = true;
        result = {
          candidateDigest: candidate.candidateDigest,
          factSetDigest: digest(
            conflict ? 'changed fixture facts' : 'stable fixture facts',
          ),
          decision: candidate.text === invalidText ? 'repair' : 'pass',
          issues: [
            mode === 'empty-response'
              ? 'empty_response'
              : 'invalid_delivery_link',
          ],
          references: [reference],
        };
      } else if (method === 'allrice/assistant/delivery-repair-authorize') {
        const authority = {
          allowed: true,
          runId,
          generation: 7,
          attempt: 1,
          workerLeaseDigest: digest('original fixture lease'),
          originalDeadlineAt,
          provider: 'offline-bounded-repair',
          model: 'static-only',
          remainingModelCalls: 8 - calls.length,
          remainingOutputTokens:
            1024 - calls.reduce((sum, call) => sum + call.outputTokens, 0),
        };
        authorities.push({ phase: params.phase, ...authority });
        result = authority;
      } else if (
        method === 'allrice/assistant/delivery-repair-close-preparation'
      ) {
        const call = calls.find((value) => value.callId === params.callId)!;
        if (!call) throw Error('FIXTURE_WRONG_PREPARATION');
        if (abort.signal.aborted)
          throw Error('assistant_runtime_cancel_requested');
        if (call.dispatchCommitted) throw Error('model_already_dispatched');
        const alreadyClosed = call.closed;
        call.closed = true;
        result = { closed: true, callId: call.callId, alreadyClosed };
      } else result = { recorded: true };
      action.result = result;
      return result;
    } catch (error) {
      action.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  });
  const loop = pollEmployeeConversationSteers({
    ownership: owner,
    generation: 7,
    threadId: id,
    turnId,
    signal: abort.signal,
    adapter,
    polling: () => polling,
    delivery,
  });
  cleanups.push(async () => {
    polling = false;
    abort.abort();
    delivery.dispose();
    await loop;
    await pool.close();
    await rm(root, { recursive: true, force: true });
  });
  await request(client, 'fixture/start', {
    mode,
    nativeSessionId: id,
    runId,
    validText,
    invalidText,
  });
  return {
    mode,
    client,
    id,
    runId,
    turnId,
    originalDeadlineAt,
    reference,
    validText,
    invalidText,
    calls,
    actions,
    authorities,
    command,
    delivery,
    streaming,
    preparedRequest,
    queueHuman: () => {
      pending = true;
    },
    cancel: async () => {
      abort.abort();
      await request(client, 'fixture/cancel-prepared');
    },
    consumed: () => consumed,
    async snapshot() {
      const snapshot = await request<Snapshot>(client, 'fixture/snapshot');
      if (pending)
        await vi.waitFor(() => expect(consumed).toBe(true), { timeout: 5000 });
      expect(snapshot.networkAttempts).toBe(0);
      expect(
        snapshot.requests.every(
          (call) => call.sameOriginalTurnSignal && call.maxTokens === 128,
        ),
      ).toBe(true);
      expect(
        snapshot.events.filter((event) => event.type === 'turn/start'),
      ).toHaveLength(1);
      if (prepared)
        await writeFile(
          join(prepared, 'evidence', mode + '.json'),
          JSON.stringify(
            {
              mode,
              sdk: '0.2.1-rc.2',
              externalModelCalls: 0,
              databaseAndAuthority: 'explicit fixtures',
              originalDeadlineAt,
              command,
              calls,
              actions,
              authorities,
              consumed: db.consume.mock.calls,
              deferred: db.defer.mock.calls,
              rejected: db.reject.mock.calls,
              snapshot,
            },
            null,
            2,
          ) + '\n',
        );
      return snapshot;
    },
  };
}
function notices(snapshot: Snapshot) {
  return snapshot.events.filter(
    (event) =>
      event.type === 'user/message' &&
      event.data.source?.kind === 'allrice-final-delivery-repair',
  );
}
function method(actions: Action[], name: string) {
  return actions.filter(
    (action) => action.method === 'allrice/assistant/' + name,
  );
}
async function expectOriginalHuman(
  h: Awaited<ReturnType<typeof fixture>>,
  snapshot: Snapshot,
) {
  await vi.waitFor(() => expect(h.consumed()).toBe(true), { timeout: 5000 });
  const input = snapshot.events.find(
    (event) =>
      event.type === 'allrice/input/request' &&
      event.data.inputId === h.command.clientUserMessageId,
  )!;
  const adopted = snapshot.events.find(
    (event) =>
      event.type === 'user/message' && event.data.id === input.data.messageId,
  )!;
  expect(input.data.turnId).toBe(h.turnId);
  expect(adopted.data.source).toEqual({ kind: 'user' });
  expect(adopted.data.content).toEqual([
    { type: 'text', text: h.command.message },
  ]);
  expect(db.consume).toHaveBeenCalledExactlyOnceWith({
    commandId: h.command.id,
    workerId: expect.any(String),
    proof: {
      status: 'adopted',
      inputId: h.command.clientUserMessageId,
      messageId: adopted.data.id,
      sequence: adopted.seq,
      turnId: h.turnId,
      checkpoint: 'step_user_message',
    },
  });
  expect(db.reject).not.toHaveBeenCalled();
  expect(snapshot.toolBodies).toEqual([
    { name: 'fixture_business', turnId: h.turnId },
  ]);
}

it('a valid original reply makes no repair request, notice, gate or extra model call', async () => {
  const h = await fixture('pass'),
    snapshot = await h.snapshot();
  expect(snapshot.steps).toBe(1);
  expect(snapshot.errors).toEqual([]);
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]?.dispatchCommitted).toBe(true);
  expect(notices(snapshot)).toEqual([]);
  expect(h.authorities).toEqual([]);
  expect(method(h.actions, 'input-gate-pause')).toEqual([]);
  expect(method(h.actions, 'delivery-repair-close-preparation')).toEqual([]);
});

it('the actual helper repairs an invalid link once in the same Agent/turn, budget and original deadline', async () => {
  const h = await fixture('repair'),
    snapshot = await h.snapshot();
  expect(snapshot.errors).toEqual([]);
  expect(snapshot.steps).toBe(2);
  expect(h.calls).toHaveLength(2);
  expect(h.calls.map((call) => call.outputTokens)).toEqual([128, 128]);
  expect(h.calls.map((call) => call.runId)).toEqual([h.runId, h.runId]);
  expect(h.calls.map((call) => call.originalDeadlineAt)).toEqual([
    h.originalDeadlineAt,
    h.originalDeadlineAt,
  ]);
  expect(h.calls[1]?.requestedOutputTokens).toBe(h.calls[0]?.outputTokens);
  expect(h.authorities.map((authority) => authority.phase)).toEqual([
    'propose',
    'prepared',
    'consume',
    'dispatch',
  ]);
  expect(
    h.authorities.every(
      (authority) =>
        authority.originalDeadlineAt === h.originalDeadlineAt &&
        authority.runId === h.runId,
    ),
  ).toBe(true);
  const messages = snapshot.events.filter(
    (event) => event.type === 'assistant/message',
  );
  expect(messages.map(text)).toEqual([h.invalidText, h.validText]);
  const notice = notices(snapshot);
  expect(notice).toHaveLength(1);
  expect(notice[0]?.data.source?.form).toBe('notice');
  const payload = JSON.parse(notice[0]!.data.content![0]!.text!);
  expect(payload.originalMessageId).toBe(messages[0]?.data.message?.id);
  expect(payload.originalDigest).toBe(digest(h.invalidText));
  expect(payload.references).toEqual([h.reference]);
  expect(method(h.actions, 'input-gate-pause')).toHaveLength(1);
  expect(method(h.actions, 'input-gate-release')).toHaveLength(1);
  expect(method(h.actions, 'delivery-repair-close-preparation')).toEqual([]);
  expect(h.delivery.paused()).toBe(false);
});

it('a genuinely late queued human input keeps its original ID/source and executes the next ordinary tool', async () => {
  const h = await fixture('late-human');
  await h.streaming.promise;
  expect(h.delivery.paused()).toBe(true);
  h.queueHuman();
  await request(h.client, 'fixture/release-provider');
  const snapshot = await h.snapshot();
  expect(snapshot.steps).toBe(4);
  expect(snapshot.errors).toEqual([]);
  expect(notices(snapshot)).toHaveLength(1);
  await expectOriginalHuman(h, snapshot);
  expect(h.calls).toHaveLength(4);
  expect(h.authorities).toHaveLength(4);
  expect(h.delivery.paused()).toBe(false);
});

it.each(['tool', 'ask'])(
  'repair %s is denied before its body and cannot dispatch a third model call',
  async (mode) => {
    const h = await fixture(mode),
      snapshot = await h.snapshot();
    expect(snapshot.steps).toBe(2);
    expect(snapshot.toolBodies).toEqual([]);
    expect(notices(snapshot)).toHaveLength(1);
    expect(h.calls).toHaveLength(2);
    expect(snapshot.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot.events)).toContain(
      'FINAL_DELIVERY_REPAIR_TOOLS_FORBIDDEN',
    );
    expect(method(h.actions, 'model-dispatch')).toHaveLength(2);
    expect(h.delivery.paused()).toBe(false);
  },
);

it('repair compaction is refused by the actual llm hook before another preparation/provider call', async () => {
  const h = await fixture('compaction');
  await h.streaming.promise;
  expect(await request(h.client, 'fixture/probe-compaction')).toEqual({
    kind: 'compaction',
    code: 'FINAL_DELIVERY_REPAIR_DISPATCH_LIMIT',
  });
  await request(h.client, 'fixture/release-provider');
  const snapshot = await h.snapshot();
  expect(snapshot.steps).toBe(2);
  expect(snapshot.errors).toEqual([]);
  expect(h.calls).toHaveLength(2);
  expect(snapshot.probes).toHaveLength(1);
});

it('an actual always-retry plugin cannot retry the unique failed repair model request', async () => {
  const h = await fixture('retry'),
    snapshot = await h.snapshot();
  expect(snapshot.steps).toBe(2);
  expect(h.calls).toHaveLength(2);
  expect(snapshot.events.filter((event) => event.type === 'llm/retry')).toEqual(
    [],
  );
  expect(snapshot.errors.length).toBeGreaterThan(0);
  expect(method(h.actions, 'model-dispatch')).toHaveLength(2);
  expect(method(h.actions, 'delivery-repair-close-preparation')).toEqual([]);
});

it('a pre-notice fact conflict closes only the exact unused call, ACKs, then hands off the original input', async () => {
  const h = await fixture('pre-notice-conflict'),
    snapshot = await h.snapshot();
  expect(snapshot.steps).toBe(3);
  expect(snapshot.errors).toEqual([]);
  expect(notices(snapshot)).toEqual([]);
  expect(h.calls).toHaveLength(4);
  const unused = h.calls[1]!;
  expect(unused.closed).toBe(true);
  expect(unused.dispatchAttempted).toBe(false);
  expect(unused.settlement).toBeUndefined();
  const close = method(h.actions, 'delivery-repair-close-preparation');
  expect(close).toHaveLength(1);
  expect(close[0]?.params.callId).toBe(unused.callId);
  expect(close[0]?.result).toEqual({
    closed: true,
    callId: unused.callId,
    alreadyClosed: false,
  });
  expect(h.actions.indexOf(close[0]!)).toBeLessThan(
    h.actions.indexOf(method(h.actions, 'input-gate-release')[0]!),
  );
  await expectOriginalHuman(h, snapshot);
  expect(h.delivery.paused()).toBe(false);
});

// These are enabled after the root's consumed-before-dispatch cleanup patch is
// integrated. They exercise the actual runtime, not an extracted/replaced body.
it('a failure after request consumes preparation closes the unused exact call before dispatch', async () => {
  const h = await fixture('prepare-failure'),
    snapshot = await h.snapshot();
  expect(snapshot.steps).toBe(1);
  expect(h.calls).toHaveLength(2);
  expect(h.calls[1]?.closed).toBe(true);
  expect(h.calls[1]?.dispatchAttempted).toBe(false);
  expect(method(h.actions, 'delivery-repair-close-preparation')).toHaveLength(
    1,
  );
  expect(snapshot.flushError).toBeUndefined();
  expect(h.delivery.paused()).toBe(false);
});

it.each(['dispatch-unknown-no-commit', 'dispatch-unknown-committed'])(
  'dispatch ACK uncertainty (%s) needs SQL close proof and preserves committed unknown usage',
  async (mode) => {
    const h = await fixture(mode),
      snapshot = await h.snapshot();
    expect(snapshot.steps).toBe(1);
    expect(h.calls).toHaveLength(2);
    const call = h.calls[1]!;
    expect(call.dispatchAttempted).toBe(true);
    expect(call.settlement).toBeUndefined();
    const close = method(h.actions, 'delivery-repair-close-preparation');
    expect(close).toHaveLength(1);
    if (mode === 'dispatch-unknown-no-commit') {
      expect(call.dispatchCommitted).toBe(false);
      expect(call.closed).toBe(true);
      expect(close[0]?.result).toMatchObject({
        closed: true,
        callId: call.callId,
      });
      expect(snapshot.flushError).toBeUndefined();
    } else {
      expect(call.dispatchCommitted).toBe(true);
      expect(call.closed).toBe(false);
      expect(close[0]?.error).toBe('model_already_dispatched');
      expect(snapshot.flushError).toMatchObject({
        code: -32603,
        message: 'AllRice Tool Broker request failed',
      });
    }
    expect(h.delivery.paused()).toBe(false);
  },
);

it('cancellation after consume cannot relax close authority or forge zero usage', async () => {
  const h = await fixture('abort-before-dispatch');
  await h.preparedRequest.promise;
  await h.cancel();
  const snapshot = await h.snapshot();
  expect(snapshot.steps).toBe(1);
  expect(h.calls).toHaveLength(2);
  expect(h.calls[1]?.dispatchAttempted).toBe(false);
  expect(h.calls[1]?.closed).toBe(false);
  expect(h.calls[1]?.settlement).toBeUndefined();
  const close = method(h.actions, 'delivery-repair-close-preparation');
  expect(close).toHaveLength(1);
  expect(
    close.every(
      (action) => action.error === 'assistant_runtime_cancel_requested',
    ),
  ).toBe(true);
  expect(snapshot.flushError).toBeDefined();
  expect(h.delivery.paused()).toBe(false);
});

it.each(['operations-tail', 'empty-response'])(
  'the actual helper handles %s once without rewriting the original answer',
  async (mode) => {
    const h = await fixture(mode),
      snapshot = await h.snapshot();
    expect(snapshot.errors).toEqual([]);
    expect(snapshot.steps).toBe(2);
    const messages = snapshot.events.filter(
      (event) => event.type === 'assistant/message',
    );
    expect(messages.map(text)).toEqual([h.invalidText, h.validText]);
    expect(notices(snapshot)).toHaveLength(1);
    expect(h.calls).toHaveLength(2);
    if (mode === 'operations-tail')
      expect(h.validText.replace(h.reference.downloadUrl, '／api')).toBe(
        h.invalidText,
      );
    expect(
      JSON.parse(notices(snapshot)[0]!.data.content![0]!.text!).references,
    ).toEqual([h.reference]);
  },
);

it('the actual shared repair ingress guard and binding guard refuse recovery/rebind before another Agent can replace the held one', async () => {
  const h = await fixture('recover');
  await h.streaming.promise;
  expect(h.delivery.paused()).toBe(true);
  await expect(request(h.client, 'fixture/probe-rebind')).rejects.toThrow(
    'assistant_native_already_bound',
  );
  await expect(
    request(h.client, 'fixture/probe-recover'),
  ).rejects.toMatchObject({ code: 'ASSISTANT_COMPLETING' });
  await request(h.client, 'fixture/release-provider');
  const snapshot = await h.snapshot();
  expect(snapshot.recoverBodyEntered).toBe(0);
  expect(snapshot.steps).toBe(2);
  expect(snapshot.errors).toEqual([]);
  expect(h.calls).toHaveLength(2);
  expect(notices(snapshot)).toHaveLength(1);
});
