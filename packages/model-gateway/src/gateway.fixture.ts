/** Synthetic fixture only. In-memory storage does NOT prove distributed admission. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { Context } from '@deepseek-ai/cordis';
import Llm, { LlmError } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type {
  PersonVmAdmissionBoundary,
  PersonVmAdmissionLease,
  PersonVmAdmissionObservation,
  PersonVmAdmissionPermit,
  PersonVmAdmissionPort,
  PersonVmBinding,
} from '@allrice/person-vm';
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai';
import Credentials from '@deepseek-ai/dsh-credentials-local';
import { ModelGatewayError } from './contract.ts';
import type {
  ModelAttemptReceipt,
  ModelAttemptStart,
  ModelCallBinding,
  ModelGatewayAuthority,
  ModelGatewayAdmission,
  ModelGatewayStore,
  GatewayProvider,
} from './contract.ts';
import { createModelGateway } from './gateway.ts';
import { createDshGatewayProvider, GatewayLlmAdapter } from './dsh-provider.ts';
import { nativeCallKey } from './postgres-store.ts';
import { summarizeAttempts, unknownUsage } from './usage.ts';

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Protocol fixture only: no PG/distributed fencing or continuous-idle proof. */
export class FixtureAdmission implements PersonVmAdmissionBoundary {
  records = new Map<
    PersonVmAdmissionPermit,
    {
      state: 'queued' | 'active' | 'deferred';
      controller: AbortController;
      pending: Set<Promise<unknown>>;
      unsafe: boolean;
    }
  >();
  finished: PersonVmAdmissionPermit[] = [];
  finishCalls: PersonVmAdmissionPermit[] = [];
  deferred = deferred();
  activated = deferred();
  waiting = deferred();
  lease: PersonVmAdmissionLease | null = null;
  wakeCount = 0;
  gatewayReleased = false;
  entryReleased = false;
  ready = deferred<PersonVmBinding>();
  failFinish = false;
  readonly participant: PersonVmAdmissionPort = {
    participant: 'gateway',
    observe: async (binding) => this.observe(binding),
    subscribe: async () => {
      throw new Error('fixture has no continuous source');
    },
    freeze: async (lease) => {
      this.lease = lease;
      return this.observe(lease.binding);
    },
    assertFrozen: async (lease) => {
      if (JSON.stringify(this.lease) !== JSON.stringify(lease))
        throw new Error('fixture stale lease');
    },
    thaw: async (lease) => {
      if (JSON.stringify(this.lease) !== JSON.stringify(lease))
        return 'superseded';
      const previous = this.gatewayReleased;
      this.gatewayReleased = true;
      this.release();
      return previous ? 'already-released' : 'released';
    },
  };
  get injection(): ModelGatewayAdmission {
    return { boundary: this, participant: this.participant };
  }
  observe(binding: PersonVmBinding): PersonVmAdmissionObservation {
    const records = [...this.records].filter(
      ([permit]) => JSON.stringify(permit.binding) === JSON.stringify(binding),
    );
    return {
      binding,
      participant: 'gateway',
      observedAt: new Date().toISOString(),
      state: 'known',
      frozen: this.gatewayReleased ? null : this.lease,
      active: records.filter(([, value]) => value.state === 'active').length,
      queued: records.filter(([, value]) => value.state === 'queued').length,
      deferred: records.filter(([, value]) => value.state === 'deferred')
        .length,
      coverage: {
        state: 'unknown',
        cursor: null,
        reason: 'synthetic protocol fixture',
      },
    };
  }
  release() {
    if (this.gatewayReleased && this.entryReleased)
      this.ready.resolve(this.lease!.binding);
  }
  async admit(
    _context: ModelCallBinding['context'],
    binding: PersonVmBinding,
    input: { participant: 'gateway' | 'entry'; operationId: string },
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const disposition =
      this.lease && !(this.gatewayReleased && this.entryReleased)
        ? 'deferred'
        : 'queued';
    const permit: PersonVmAdmissionPermit = {
      permitId: input.operationId,
      binding,
      participant: input.participant,
      disposition,
      signal: AbortSignal.any([signal, controller.signal]),
    };
    this.records.set(permit, {
      state: disposition,
      controller,
      pending: new Set(),
      unsafe: false,
    });
    if (disposition === 'deferred') this.deferred.resolve();
    return permit;
  }
  queued<T>(
    permit: PersonVmAdmissionPermit,
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ) {
    return this.track(permit, operation, signal);
  }
  activate<T>(
    permit: PersonVmAdmissionPermit,
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ) {
    const record = this.records.get(permit)!;
    if (record.state !== 'queued')
      return Promise.reject(new Error('fixture duplicate activation'));
    record.state = 'active';
    this.activated.resolve();
    return this.track(permit, operation, signal);
  }
  async waitUntilReady(
    _context: ModelCallBinding['context'],
    permit: PersonVmAdmissionPermit,
    signal: AbortSignal,
  ) {
    const record = this.records.get(permit)!;
    // Like the producer's deferred subscription, this owns only a cancelable
    // wait. No native business callback entered, so cancellation is not unsafe.
    const pending = (async () => {
      const current = AbortSignal.any([signal, permit.signal]);
      current.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          current.removeEventListener('abort', abort);
          reject(current.reason);
        };
        current.addEventListener('abort', abort, { once: true });
        void this.ready.promise.then(() => {
          current.removeEventListener('abort', abort);
          resolve();
        });
        this.waiting.resolve();
        if (current.aborted) abort();
      });
      current.throwIfAborted();
      this.wakeCount++;
      return this.ready.promise;
    })();
    record.pending.add(pending);
    void pending.finally(() => record.pending.delete(pending)).catch(() => {});
    return pending;
  }
  private track<T>(
    permit: PersonVmAdmissionPermit,
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ) {
    const record = this.records.get(permit)!;
    const pending = Promise.resolve().then(async () => {
      const current = AbortSignal.any([signal, permit.signal]);
      current.throwIfAborted(); // Before callback entry, not an unknown child.
      try {
        return await operation(current);
      } catch (error) {
        record.unsafe = true;
        throw error;
      }
    });
    record.pending.add(pending);
    void pending.finally(() => record.pending.delete(pending)).catch(() => {});
    return pending;
  }
  async finish(permit: PersonVmAdmissionPermit) {
    this.finishCalls.push(permit);
    const record = this.records.get(permit);
    if (!record) return;
    record.controller.abort(new Error('fixture finish'));
    await Promise.allSettled([...record.pending]);
    if (record.unsafe)
      throw Object.assign(new Error('fixture actual join unknown'), {
        code: 'CLEANUP_INCOMPLETE',
      });
    if (this.failFinish) throw new ModelGatewayError('LEDGER_UNAVAILABLE');
    this.records.delete(permit);
    this.finished.push(permit);
  }
}
export function modelBinding(
  personId: string = randomUUID(),
  organizationId: string = randomUUID(),
): ModelCallBinding {
  return {
    context: {
      requestId: randomUUID(),
      sessionId: randomUUID(),
      actor: { type: 'user', id: personId },
      organizationId,
      workspaceId: null,
      memberships: [],
      authenticatedAt: new Date().toISOString(),
    },
    vm: {
      vmId: randomUUID(),
      personId,
      organizationId,
      instanceId: randomUUID(),
      leaseEpoch: 1,
    },
    execution: { runId: randomUUID(), executionId: randomUUID() },
    employeeInstanceId: randomUUID(),
    employeeRelease: 'sha256:employee-fixture',
    allriceThreadRef: randomUUID(),
    native: {
      instanceId: randomUUID(),
      profile: 'fixture',
      sessionId: 'root',
      rootSessionId: 'root',
      parentSessionId: null,
      callId: randomUUID(),
    },
    executionGeneration: '4.0',
    gatewayRelease: 'sha256:gateway-fixture',
    provider: 'openai-compatible',
    model: 'fixture-model',
  };
}
export const freshCall = (binding: ModelCallBinding): ModelCallBinding => ({
  ...binding,
  context: { ...binding.context, requestId: randomUUID() },
  native: { ...binding.native, callId: randomUUID() },
});
const pendingReceipt = (attempt: ModelAttemptStart): ModelAttemptReceipt => ({
  ...attempt,
  dispatchObserved: null,
  httpStatus: null,
  terminal: null,
  outcome: 'unknown',
  usage: unknownUsage(),
});

export class FixtureStore implements ModelGatewayStore {
  calls = new Map<string, { binding: ModelCallBinding; digest: string }>();
  keys = new Set<string>();
  rows = new Map<string, ModelAttemptReceipt>();
  slots = new Map<string, Set<string>>();
  listeners = new Map<string, Set<() => void>>();
  recovered = new Set<string>();
  queued = deferred();
  failFinish = false;
  beforeStart?: () => Promise<void>;
  async claimCall(binding: ModelCallBinding, digest: string) {
    const key = nativeCallKey(binding);
    if (this.keys.has(key)) throw new ModelGatewayError('DUPLICATE_CALL');
    this.keys.add(key);
    const id = randomUUID();
    this.calls.set(id, { binding, digest });
    return id;
  }
  async watchCapacity(personId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    let notified = false;
    let wake: (() => void) | undefined;
    const pulse = () => {
      notified = true;
      wake?.();
      wake = undefined;
    };
    const listeners = this.listeners.get(personId) ?? new Set();
    this.listeners.set(personId, listeners);
    listeners.add(pulse);
    signal.addEventListener('abort', pulse);
    return {
      async wait() {
        signal.throwIfAborted();
        if (!notified)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        notified = false;
        signal.throwIfAborted();
      },
      async close() {
        listeners.delete(pulse);
        signal.removeEventListener('abort', pulse);
        pulse();
      },
    };
  }
  async tryStartAttempt(attempt: ModelAttemptStart) {
    await this.beforeStart?.();
    if (attempt.kind === 'model') {
      const slots = this.slots.get(attempt.personId) ?? new Set();
      this.slots.set(attempt.personId, slots);
      if (slots.size >= 8) {
        this.queued.resolve();
        return false;
      }
      slots.add(attempt.id);
    }
    this.rows.set(attempt.id, pendingReceipt(attempt));
    return true;
  }
  async finishAttempt(receipt: ModelAttemptReceipt) {
    if (this.failFinish) throw new ModelGatewayError('LEDGER_UNAVAILABLE');
    this.rows.set(receipt.id, receipt);
    if (receipt.outcome === 'unknown') return;
    this.slots.get(receipt.personId)?.delete(receipt.id);
    for (const listener of this.listeners.get(receipt.personId) ?? [])
      listener();
  }
  async attempts(callId: string) {
    return [...this.rows.values()].filter((r) => r.callId === callId);
  }
  async usage(personId: string, organizationId: string) {
    const calls = new Set(
      [...this.calls]
        .filter(
          ([, c]) =>
            c.binding.vm.personId === personId &&
            c.binding.vm.organizationId === organizationId,
        )
        .map(([id]) => id),
    );
    return summarizeAttempts(
      [...this.rows.values()].filter((r) => calls.has(r.callId)),
    );
  }
  async reconcileOwner(ownerId: string, evidenceRef: string) {
    if (!evidenceRef) throw new ModelGatewayError('AUTHORIZATION_DENIED');
    let count = 0;
    for (const row of this.rows.values())
      if (
        row.ownerId === ownerId &&
        row.outcome === 'unknown' &&
        !this.recovered.has(row.id)
      ) {
        this.recovered.add(row.id);
        this.slots.get(row.personId)?.delete(row.id);
        for (const listener of this.listeners.get(row.personId) ?? [])
          listener();
        count++;
      }
    return count;
  }
}

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw Error('fixture_listener_missing');
  return `http://127.0.0.1:${address.port}`;
}
export async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
const frame = (data: unknown) => 'data: ' + JSON.stringify(data) + '\n\n';
const delta = (value: object, finish_reason: string | null = null) =>
  frame({
    id: 'chatcmpl-fixture',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fixture-model',
    choices: [{ index: 0, delta: value, finish_reason }],
  });

export async function upstreamFixture(
  options: {
    hold?: boolean;
    status?: number;
    firstAttemptStatus?: number;
    firstRequestStatus?: number;
    missingTerminal?: boolean;
    missingUsage?: boolean;
    tools?: boolean;
    disconnectBeforeHeaders?: boolean;
  } = {},
) {
  const requests: {
    url: string;
    body: Record<string, unknown>;
    response: ServerResponse;
  }[] = [];
  const waits = new Map<number, ReturnType<typeof deferred<void>>>();
  const closed = deferred();
  let active = 0;
  let maxActive = 0;
  let redirectHits = 0;
  let redirect = false;
  const complete = (response: ServerResponse) => {
    if (response.destroyed || response.writableEnded) return;
    if (!options.missingTerminal)
      response.write(delta({}, options.tools ? 'tool_calls' : 'stop'));
    if (!options.missingUsage)
      response.write(
        frame({
          choices: [],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 3,
            total_tokens: 15,
            prompt_tokens_details: { cached_tokens: 4 },
          },
        }),
      );
    response.end(options.missingTerminal ? '' : 'data: [DONE]\n\n');
  };
  const server = createServer((request, response) => {
    void (async () => {
      const bytes = [];
      for await (const chunk of request) bytes.push(Buffer.from(chunk));
      if (request.url === '/redirect-target') {
        redirectHits++;
        response.end('{}');
        return;
      }
      const body = bytes.length
        ? (JSON.parse(Buffer.concat(bytes).toString('utf8')) as Record<
            string,
            unknown
          >)
        : {};
      requests.push({ url: request.url!, body, response });
      waits.get(requests.length)?.resolve();
      if (options.disconnectBeforeHeaders) {
        response.destroy();
        return;
      }
      if (options.firstRequestStatus && requests.length === 1) {
        response.writeHead(options.firstRequestStatus, {
          'content-length': '0',
        });
        response.end();
        return;
      }
      if (request.url === '/refresh') {
        response.setHeader('content-type', 'application/json');
        response.end('{"synthetic":true}');
        return;
      }
      if (redirect) {
        response.writeHead(307, { location: '/redirect-target' });
        response.end();
        return;
      }
      const status =
        request.url === '/v1/first-attempt'
          ? options.firstAttemptStatus
          : options.status;
      if (status) {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end('{"error":{"message":"synthetic upstream refusal"}}');
        return;
      }
      active++;
      maxActive = Math.max(maxActive, active);
      response.on('close', () => {
        active--;
        closed.resolve();
      });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(delta({ role: 'assistant' }));
      response.write(delta({ content: 'Hello ' }));
      response.write(delta({ content: 'world' }));
      if (options.tools) {
        response.write(
          delta({
            tool_calls: [
              {
                index: 0,
                id: 'call-fixture',
                type: 'function',
                function: { name: 'lookup', arguments: '{"q":' },
              },
            ],
          }),
        );
        response.write(
          delta({
            tool_calls: [{ index: 0, function: { arguments: '"rice"}' } }],
          }),
        );
      }
      if (!options.hold) complete(response);
    })().catch((error) => {
      response.destroy(error as Error);
    });
  });
  const url = await listen(server);
  return {
    url,
    requests,
    server,
    closed: closed.promise,
    get active() {
      return active;
    },
    get maxActive() {
      return maxActive;
    },
    get redirectHits() {
      return redirectHits;
    },
    setRedirect() {
      redirect = true;
    },
    whenCount(count: number) {
      if (requests.length >= count) return Promise.resolve();
      const wait = deferred();
      waits.set(count, wait);
      return wait.promise;
    },
    complete(index: number) {
      complete(requests[index]!.response);
    },
    async close() {
      await closeServer(server);
    },
  };
}

export async function nativeProviderFixture(
  upstream: string,
  options: {
    api?: 'openai-completions' | 'openai-responses' | 'openai-codex-responses';
  } = {},
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-model-gateway-')),
  );
  // Deliberately synthetic, never copied from environment/store/browser/login.
  const envKey = 'ALLRICE_GATEWAY_SYNTHETIC_API_KEY';
  const previous = process.env[envKey];
  process.env[envKey] =
    options.api === 'openai-codex-responses'
      ? [
          'synthetic',
          Buffer.from(
            JSON.stringify({
              'https://api.openai.com/auth': {
                chatgpt_account_id: 'synthetic-account',
              },
            }),
          ).toString('base64url'),
          'unsigned-fixture',
        ].join('.')
      : 'synthetic-loopback-only';
  const ctx = new Context();
  const route =
    options.api === 'openai-codex-responses'
      ? { provider: 'openai-codex', model: 'gpt-5.6-luna' }
      : { provider: 'openai-compatible', model: 'fixture-model' };
  const credentialPath = join(directory, 'synthetic-credentials.yaml');
  try {
    await ctx.plugin(Llm);
    await ctx.plugin(Credentials, {
      path: credentialPath,
      watch: false,
    });
    await ctx.plugin(PiAi, {
      providers: {
        [route.provider]: {
          apiKeyEnv: envKey,
          ...(options.api === 'openai-codex-responses'
            ? {}
            : { api: options.api ?? 'openai-completions' }),
          baseURL: upstream + '/v1',
          transport: 'sse',
          retryPolicy: { mode: 'normal', maxRetries: 0 },
          models: [
            {
              id: route.model,
              contextWindow: 4096,
              maxTokens: 512,
              input: ['text'],
            },
          ],
        },
      },
    });
    const provider = createDshGatewayProvider(ctx.llm, {
      ...route,
      transport: 'sse',
      classify(input) {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.origin !== upstream) return null;
        return {
          kind: url.pathname === '/refresh' ? 'auth-refresh' : 'model',
          protocol:
            url.pathname === '/refresh'
              ? 'opaque'
              : options.api && options.api !== 'openai-completions'
                ? 'openai-responses'
                : 'openai-chat-completions',
        };
      },
    });
    return {
      ctx,
      credentialPath,
      route,
      provider,
      async close() {
        await ctx.fiber.dispose();
        if (previous === undefined) delete process.env[envKey];
        else process.env[envKey] = previous;
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await ctx.fiber.dispose();
    if (previous === undefined) delete process.env[envKey];
    else process.env[envKey] = previous;
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function gatewayFixture(options: {
  provider: GatewayProvider;
  store?: FixtureStore;
  binding?: ModelCallBinding;
  authority?: ModelGatewayAuthority;
  admission?: FixtureAdmission;
  nextBinding?: (index: number) => ModelCallBinding;
}) {
  const store = options.store ?? new FixtureStore();
  const binding = options.binding ?? modelBinding();
  const admission = options.admission ?? new FixtureAdmission();
  let allowed = true;
  const checked: ModelCallBinding[] = [];
  const authority: ModelGatewayAuthority = options.authority ?? {
    async assertCall(value, signal) {
      await Promise.resolve();
      signal.throwIfAborted();
      checked.push(value);
      if (!allowed) throw new ModelGatewayError('AUTHORIZATION_DENIED');
    },
    async authorizeUsage(context) {
      return {
        personId: context.actor.id,
        organizationId: context.organizationId,
      };
    },
    async confirmOwnerStopped() {
      throw new ModelGatewayError('AUTHORIZATION_DENIED');
    },
  };
  const gateway = createModelGateway({
    ownerId: randomUUID(),
    authority,
    store,
    provider: options.provider,
    admission: admission.injection,
  });
  let index = 0;
  const errors: unknown[] = [];
  const server = createServer((request, response) => {
    // This is a host fixture route, independent of ALL guest headers/body.
    const callBinding = options.nextBinding?.(index++) ?? freshCall(binding);
    void gateway
      .handle(request, response, callBinding, new AbortController().signal)
      .catch((error) => {
        errors.push(error);
        response.destroy();
      });
  });
  const url = await listen(server);
  const adapter = new GatewayLlmAdapter(url + '/v1/stream');
  const input = (signal?: AbortSignal): GenerateOptions => ({
    provider: 'host-gateway',
    model: 'fixture-model',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '请查一下大米价格。' }] },
    ],
    signal,
    tools: [
      {
        name: 'lookup',
        description: 'Read a synthetic rice price.',
        parameters: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: ['q'],
        },
      },
    ],
  });
  return {
    gateway,
    admission,
    server,
    store,
    binding,
    checked,
    errors,
    adapter,
    url,
    input,
    deny() {
      allowed = false;
    },
    async collect(options = input()) {
      const result: StreamChunk[] = [];
      for await (const chunk of adapter.stream(options)) result.push(chunk);
      return result;
    },
    async close() {
      await gateway.close();
      await closeServer(server);
    },
  };
}
export const nativeFailure = (code: string): StreamChunk => ({
  type: 'finish',
  reason: {
    kind: 'error',
    failure: new LlmError('Synthetic failure', code).failure,
  },
});
