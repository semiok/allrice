import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService, isTypertRemoteMethod, remoteErrorOf, type PeerScope, type RemoteStream, type TypertDisposer, type TypertRemoteMethod } from '@deepseek-ai/dsh-typert-protocol';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-api-gateway';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import { TYPERT_REMOTE as Native } from '@deepseek-ai/dsh-api-session-controller/remote';
import { TYPERT_REMOTE as Access } from '@deepseek-ai/dsh-api-remote-access/remote';
import { REMOTE_EVENT_STREAM_ENDPOINT, REMOTE_EVENT_STREAM_PAYLOAD, isRemoteEventClientId } from '@deepseek-ai/dsh-api-gateway/stream-protocol';
import { z } from 'zod';
import { TYPERT, TYPERT_REMOTE } from '#principal-artifacts';
import { UuidSchema } from '@allrice/contracts';
import { issueSchema, principalPolicy, projectSessions, writeEndpoints, type Projection } from './policy.js';
import type { CloseCommand, DEntryPrincipal, DEntryPrincipalIssue, DEntryScopedUnaryCall, DEntryScopedUnaryResult, DEntryScopedStreamCall, DEntryScopedStreamFrame, ScopeFrame } from './types.js';

const object = z.record(z.string(), z.unknown());
const configSchema = z.object({
  profile: z.object({ workspaceId: UuidSchema, employeeInstanceId: UuidSchema, employeeRevision: z.number().int().positive(), employeeVersionId: UuidSchema }).strict(),
  binding: z.object({ organizationId: UuidSchema, personId: UuidSchema, vmId: z.string().min(1), instanceId: z.string().min(1), leaseEpoch: z.number().int().positive() }).strict(),
  moduleBase: z.string().min(1),
}).strict();
type HostConfig = z.infer<typeof configSchema>;
const endpoints = ['allricePrincipal/openScope', 'allricePrincipal/invokeScoped', 'allricePrincipal/streamScoped'] as const;
type Reader = TypertRemoteMethod<object, unknown> | TypertRemoteMethod<object, unknown, 'stream', unknown>;
const closed = () => Error('PRINCIPAL_SCOPE_CLOSED');
const empty = { async *[Symbol.asyncIterator]() {} };
function signalGate(signal: AbortSignal) {
  let release!: () => void;
  const done = new Promise<void>((yes) => { release = yes; });
  const abort = new AbortController();
  const stop = () => { abort.abort(closed()); release(); };
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  return { abort, done, stop, detach: () => signal.removeEventListener('abort', stop) };
}
async function commands(input: AsyncIterator<CloseCommand>, stop: () => void) {
  const next = await input.next();
  if (!next.done && next.value !== 'close') throw Error('PRINCIPAL_CLOSE_INVALID');
  stop();
}
function assertContribution(value: unknown): asserts value is TypertContribution {
  // Registry.register performs its own complete atomic validation next. Never
  // invent a descriptor or use source discovery if this artifact is absent.
  const header = z.object({ package: z.literal('@allrice/d-entry-principal'), face: z.literal('host'), schemas: z.array(z.unknown()), model: object, invocations: z.array(object) }).parse(value);
  if (header.invocations.length !== 3 || header.invocations.some((row) => !new Set<string>(endpoints).has(`${String(row.namespace)}/${String(row.method)}`))) throw Error('PRINCIPAL_METADATA_INVALID');
}
class Scope implements Projection {
  active = false;
  bindings: Projection['bindings'] = [];
  peer?: PeerScope;
  readonly abort = new AbortController();
  readonly jobs = new Set<Promise<unknown>>();
  readonly children = new Set<{ close(): Promise<void> }>();
  readonly ready: Promise<void>;
  private closing?: Promise<void>;
  private detach = () => {};
  private unregister?: TypertDisposer;
  private refreshQueue = Promise.resolve();
  constructor(readonly host: PrincipalService, readonly parent: PeerScope, readonly issue: DEntryPrincipalIssue) {
    // Registration precedes any async setup. Child Peer belongs to the exact
    // parent Context, never its own disposer or the global plugin Context.
    this.unregister = parent.ctx.effect(() => () => this.close(), 'allrice principal scope');
    const lost = () => { void this.close().catch(() => {}); };
    parent.signal.addEventListener('abort', lost, { once: true });
    const hint = () => {
      if (this.abort.signal.aborted) return;
      this.active = false; this.bindings = []; host.ctx.remoteAccess.invalidate();
      void this.own(() => this.refresh()).catch(lost);
    };
    const added = parent.ctx.on('api-session/added', hint);
    const removed = parent.ctx.on('api-session/removed', hint);
    this.detach = () => { parent.signal.removeEventListener('abort', lost); added(); removed(); };
    this.ready = Promise.resolve().then(async () => {
      this.abort.signal.throwIfAborted();
      const principal: DEntryPrincipal = Object.freeze({ kind: 'allrice-d-entry', scopeId: issue.scopeId, identity: Object.freeze({ ...issue.identity }) });
      this.peer = parent.ctx.connection.createPeer({ principal, interactions: 'answer' });
      await this.refresh();
    });
    void this.ready.catch(() => {});
    if (parent.signal.aborted) lost();
  }
  own<T>(work: () => Promise<T>): Promise<T> {
    if (this.abort.signal.aborted) return Promise.reject(this.abort.signal.reason);
    const task = Promise.resolve().then(() => { this.abort.signal.throwIfAborted(); return work(); });
    this.jobs.add(task);
    void task.then(() => this.jobs.delete(task), () => this.jobs.delete(task));
    return task;
  }
  currentPeer() { const peer = this.peer; if (!peer || this.abort.signal.aborted) throw closed(); return peer; }
  refresh() {
    this.active = false; this.bindings = []; this.host.ctx.remoteAccess.invalidate();
    const task = this.refreshQueue.then(async () => {
      this.abort.signal.throwIfAborted();
      const catalog = await this.host.ctx.sessionController.list({}, this.abort.signal);
      this.abort.signal.throwIfAborted();
      const bindings = projectSessions(this.issue, catalog.items);
      // A later hint/read already fenced this projection. Only the last
      // actual read in the queue may publish it again.
      if (this.refreshQueue === task) {
        this.bindings = bindings;
        this.active = true; this.host.ctx.remoteAccess.invalidate();
      }
    });
    this.refreshQueue = task;
    return task;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      await Promise.allSettled([this.ready]);
      const children = await Promise.allSettled([...this.children].map((child) => child.close()));
      while (this.jobs.size) await Promise.allSettled([...this.jobs]);
      const peer = await Promise.allSettled([this.peer?.dispose()]);
      if ([...children, ...peer].some((result) => result.status === 'rejected')) throw Error('PRINCIPAL_JOIN_UNKNOWN');
      this.detach();
      this.host.scopes.delete(this.issue.scopeId);
      // The registration waits this very close; withdrawing it must not await
      // itself. It owns no additional I/O beyond the resources joined above.
      void this.unregister?.().catch(() => {});
    });
    this.active = false; this.bindings = []; this.abort.abort(closed()); this.host.ctx.remoteAccess.invalidate();
    return this.closing;
  }
}

/** Actual guest service; only the trusted Node API Peer can issue a scope.
 * The public Host face is the Cordis plugin, not a constructor for consumers. */
class PrincipalService extends TypertRemoteService {
  static inject = ['connection', 'remoteAccess', 'typertGateway', 'typert', 'sessionController'];
  readonly scopes = new Map<string, Scope>();
  private stopped = false;
  constructor(ctx: Context, private readonly config: HostConfig & { readers: ReadonlyMap<string, Reader> }) {
    super(ctx, 'allricePrincipal');
    ctx.remoteAccess.registerPolicy('allrice-d-entry', principalPolicy(this.scopes));
    ctx.effect(() => async () => {
      this.stopped = true;
      const results = await Promise.allSettled([...this.scopes.values()].map((scope) => scope.close()));
      if (results.some((r) => r.status === 'rejected')) throw Error('PRINCIPAL_JOIN_UNKNOWN');
    });
  }
  private raw(endpoint: typeof endpoints[number]) {
    if (this.stopped) throw closed();
    const invocation = this.ctx.invocation;
    if (!invocation || invocation.peer.principal.kind !== 'owner' || invocation.peer.interactions !== 'none' || invocation.peer.signal.aborted) throw Error('PRINCIPAL_PARENT_INVALID');
    const reader = this.config.readers.get(endpoint);
    if (!reader) throw Error('PRINCIPAL_METADATA_INVALID');
    return object.parse(reader.input({ strict: true }).create().parse(invocation.request.args));
  }
  private scope(id: string) {
    const scope = this.scopes.get(UuidSchema.parse(id));
    if (!scope || !scope.active || scope.parent !== this.ctx.invocation.peer || scope.abort.signal.aborted) throw closed();
    return scope;
  }
  @Remote({ mode: 'stream' })
  async *openScope(issue: DEntryPrincipalIssue, signal: AbortSignal): RemoteStream<ScopeFrame, CloseCommand> {
    issue = issueSchema.parse(this.raw('allricePrincipal/openScope').issue);
    const { profile, binding } = this.config;
    if (!issue.identity.threadId || issue.identity.organizationId !== binding.organizationId || issue.identity.personId !== binding.personId || Object.keys(profile).some((key) => Reflect.get(issue.identity, key) !== Reflect.get(profile, key)) || this.scopes.has(issue.scopeId)) throw Error('PRINCIPAL_ISSUE_INVALID');
    const scope = new Scope(this, this.ctx.invocation.peer, Object.freeze({ ...issue, identity: Object.freeze({ ...issue.identity }), root: Object.freeze({ ...issue.root }) }));
    this.scopes.set(issue.scopeId, scope);
    const gate = signalGate(signal);
    const input = this.ctx.invocation.uplink<CloseCommand>()[Symbol.asyncIterator]();
    const pump = commands(input, gate.stop).catch((error) => { gate.stop(); throw error; });
    void pump.catch(() => {});
    void gate.done.then(() => scope.close()).catch(() => {});
    try {
      try { await scope.ready; }
      catch (error) { if (!gate.abort.signal.aborted) throw error; }
      if (!gate.abort.signal.aborted) {
        const peer = scope.peer;
        if (!peer || peer.principal.kind !== 'allrice-d-entry') throw closed();
        const baseline = this.ctx.remoteAccess.snapshotFor(peer.principal);
        if (baseline.owner) throw Error('PRINCIPAL_OWNER_BASELINE');
        yield { type: 'opened', scopeId: issue.scopeId, principal: peer.principal, baseline };
      }
      await gate.done; await scope.close();
      yield { type: 'closed', scopeId: issue.scopeId };
    } finally {
      gate.stop(); await scope.close(); await input.return?.(); await pump; gate.detach();
    }
  }
  private async native(scope: Scope, endpoint: string, args: Record<string, unknown>) {
    await scope.refresh();
    const request = object.parse(args.request);
    const address = request.address === undefined ? undefined : object.parse(request.address);
    const sessionId = z.string().min(1).parse(address ? address.kind === 'session' ? address.sessionId : address.childSessionId : request.sessionId);
    const catalog = await this.ctx.sessionController.list({}, scope.abort.signal);
    scope.abort.signal.throwIfAborted();
    const item = catalog.items.find((row) => String(row.sessionId) === sessionId);
    if (!item || !scope.bindings.some((row) => row.resource.kind === 'session' && String(row.resource.id) === sessionId)) throw Error('PRINCIPAL_RESOURCE_DENIED');
    if (address?.kind === 'subagent' && String(item.parentSessionId) !== address.parentSessionId) throw Error('PRINCIPAL_PARENT_DENIED');
    if (writeEndpoints.some((key) => key === endpoint) && (scope.issue.access !== 'execute' || sessionId !== scope.issue.root.nativeSessionId || item.parentSessionId)) throw Error('PRINCIPAL_WRITE_DENIED');
  }
  @Remote
  async invokeScoped(call: DEntryScopedUnaryCall, signal: AbortSignal): Promise<DEntryScopedUnaryResult> {
    const raw = object.parse(this.raw('allricePrincipal/invokeScoped').call);
    const key = z.enum(['session/attachment', 'session/page', 'session/projections', 'skills/list', ...writeEndpoints]).parse(raw.endpoint);
    const args = object.parse(Native.methods[key].input({ strict: true }).create().parse(raw.args));
    const scope = this.scope(z.string().parse(raw.scopeId));
    return scope.own(async () => {
      const active = AbortSignal.any([signal, scope.abort.signal]);
      active.throwIfAborted();
      await this.native(scope, key, args);
      active.throwIfAborted();
      const slash = key.indexOf('/');
      const value = await this.ctx.typertGateway.invoke({ namespace: key.slice(0, slash), method: key.slice(slash + 1), args, peer: scope.currentPeer(), signal: active });
      active.throwIfAborted();
      // Literal branches retain the source descriptor/result relationship.
      switch (key) {
        case 'session/attachment': return { endpoint: key, value: Native.methods[key].result.create().parse(value) };
        case 'session/page': return { endpoint: key, value: Native.methods[key].result.create().parse(value) };
        case 'session/projections': return { endpoint: key, value: Native.methods[key].result.create().parse(value) };
        case 'skills/list': return { endpoint: key, value: Native.methods[key].result.create().parse(value) };
        case 'session/prompt': return { endpoint: key, value: Native.methods[key].result.create().parse(value) };
        case 'session/updateQueue': return { endpoint: key, value: Native.methods[key].result.create().parse(value) };
        case 'session/cancel': return { endpoint: key, value: Native.methods[key].result.create().parse(value) };
        case 'session/rename': return { endpoint: key, value: Native.methods[key].result.create().parse(value) };
        case 'session/selectModel': return { endpoint: key, value: Native.methods[key].result.create().parse(value) };
      }
    });
  }
  @Remote({ mode: 'stream' })
  async *streamScoped(call: DEntryScopedStreamCall, signal: AbortSignal): RemoteStream<DEntryScopedStreamFrame, CloseCommand> {
    const raw = object.parse(this.raw('allricePrincipal/streamScoped').call);
    const scope = this.scope(z.string().parse(raw.scopeId));
    const gate = signalGate(signal);
    const input = this.ctx.invocation.uplink<CloseCommand>()[Symbol.asyncIterator]();
    const pump = commands(input, gate.stop); void pump.catch(() => gate.stop());
    let iterator: AsyncIterator<unknown> | undefined, pending: Promise<IteratorResult<unknown>> | undefined;
    let closing: Promise<void> | undefined;
    let eventReady = false;
    const events = raw.kind === 'events';
    const active = AbortSignal.any([scope.abort.signal, gate.abort.signal]);
    const setup = scope.own(async () => {
      active.throwIfAborted();
      if (events) z.object({ args: z.object({}).strict() }).strict().parse(raw.payload);
      else if (raw.endpoint === 'remoteAccess/follow') Access.methods['remoteAccess/follow'].input({ strict: true }).create().parse(raw.args);
      else {
        if (raw.endpoint !== 'session/follow') throw Error('PRINCIPAL_ENDPOINT_DENIED');
        const args = object.parse(Native.methods['session/follow'].input({ strict: true }).create().parse(raw.args));
        await this.native(scope, 'session/follow', args);
      }
      active.throwIfAborted();
      const peer = scope.currentPeer();
      const endpoint = events ? REMOTE_EVENT_STREAM_ENDPOINT : z.string().parse(raw.endpoint);
      const payload = events ? REMOTE_EVENT_STREAM_PAYLOAD : { args: raw.args };
      const values = await this.ctx.typertGateway.wireStream.open(endpoint, payload, empty, peer, active);
      iterator = values[Symbol.asyncIterator]();
    });
    const child = { close: () => {
      if (closing) return closing;
      closing = Promise.resolve().then(async () => {
        await Promise.allSettled([setup, pending]);
        const returns = await Promise.allSettled([
          Promise.resolve().then(async () => { await iterator?.return?.(); }),
          Promise.resolve().then(async () => { await input.return?.(); }),
        ]);
        const pumped = await Promise.allSettled([pump]);
        const failures = [...returns, ...pumped].flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
        if (failures.length) throw new AggregateError(failures, 'PRINCIPAL_JOIN_UNKNOWN');
        scope.children.delete(child);
      });
      gate.stop(); return closing;
    } };
    scope.children.add(child);
    let failed = false;
    try {
      await setup;
      while (!gate.abort.signal.aborted) {
        if (!iterator) throw closed();
        pending = Promise.resolve(iterator.next());
        let next: IteratorResult<unknown>;
        try { next = await pending; }
        catch (error) {
          const failure = remoteErrorOf(error);
          // Only the native Gateway cancellation caused by our own close is
          // mechanical. Its in-process cause is the exact signal reason.
          if (gate.abort.signal.aborted && !signal.aborted && failure?.code === 'gateway/cancelled' && failure.cause === active.reason) break;
          throw error;
        }
        if (next.done) break;
        if (gate.abort.signal.aborted || scope.abort.signal.aborted) break;
        let value: Extract<DEntryScopedStreamFrame, { type: 'item' }>['value'];
        if (events) {
          const ready = z.object({ type: z.literal('ready'), clientId: z.custom<ReturnType<typeof eventIdentity>>(isRemoteEventClientId), host: z.object({ home: z.string() }).strict() }).strict();
          const frame = z.union([ready, z.object({ type: z.literal('emit'), event: z.string().min(1), args: z.array(z.unknown()) }).strict()]).parse(next.value);
          if (eventReady ? frame.type === 'ready' : frame.type !== 'ready') throw Error('PRINCIPAL_EVENT_GENERATION_INVALID');
          eventReady = true; value = frame;
        } else if (raw.endpoint === 'remoteAccess/follow') value = Access.methods['remoteAccess/follow'].result.create().parse(next.value);
        else value = Native.methods['session/follow'].result.create().parse(next.value);
        yield { type: 'item', scopeId: scope.issue.scopeId, value };
      }
      await child.close(); yield { type: 'closed', scopeId: scope.issue.scopeId };
    } catch (error) { failed = true; throw error; }
    finally {
      try { await child.close(); }
      catch (error) { if (!failed) throw error; }
      finally { gate.detach(); }
    }
  }
}
// Keeps the brand predicate's output type without asserting a caller string.
function eventIdentity(value: unknown) { if (!isRemoteEventClientId(value)) throw Error('PRINCIPAL_EVENT_ID_INVALID'); return value; }
declare module '@deepseek-ai/cordis' { interface Context { allricePrincipal: PrincipalService } }
export const name = 'allrice-current-principal';
export const inject = PrincipalService.inject;
export async function apply(ctx: Context, raw: unknown): Promise<void> {
  const config = configSchema.parse(raw);
  const contribution = TYPERT; assertContribution(contribution);
  const readers = new Map<string, Reader>();
  for (const endpoint of endpoints) {
    const method = TYPERT_REMOTE.methods[endpoint];
    if (!method || !isTypertRemoteMethod(method)) throw Error('PRINCIPAL_METADATA_INVALID');
    readers.set(endpoint, method);
  }
  let metadata: TypertDisposer | undefined;
  let fiber: ReturnType<Context['plugin']> | undefined;
  try {
    metadata = ctx.typert.register(contribution);
    fiber = ctx.plugin(PrincipalService, { ...config, readers });
    await fiber;
    for (const endpoint of endpoints) {
      const local = ctx.typert.local.get(endpoint);
      if (!local || local.parameters.some((p) => p.codec.mode !== 'strict') || (endpoint !== 'allricePrincipal/invokeScoped' && !local.uplink)) throw Error('PRINCIPAL_METADATA_INVALID');
    }
  } catch (error) {
    const stopped = await Promise.allSettled([Promise.resolve().then(() => fiber?.dispose())]);
    const withdrawn = await Promise.allSettled([Promise.resolve().then(() => metadata?.())]);
    const failures = [...stopped, ...withdrawn].flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError([error, ...failures], 'PRINCIPAL_INSTALL_JOIN_UNKNOWN');
    throw error;
  }
}
