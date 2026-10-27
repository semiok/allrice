import { realpath } from 'node:fs/promises';
/* global AbortController */
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server';
import { SessionId } from '@deepseek-ai/dsh-session';
import { readStoredDshSession } from './allrice-session-compatibility.mjs';

/** One already-authorized business root per existing process Host. SDK alone
 * owns AgentHandles. These records hold public Agents, never disposal rights,
 * SDK internals, database grants or a replacement session manager. */
export class AllRiceSdkRoot {
  constructor(ctx, transport, options) {
    this.ctx = ctx;
    this.transport = transport;
    this.sdkOptions = options;
    this.roots = new Map();
    this.ownDisposers = [];
    this.epoch = 0;
    this.phase = 'uninitialized';
    this.terminated = false;
    this.forwardedSequences = new Map();
    this.sdkTransport = {
      request: (...args) => transport.request(...args),
      notify: (method, params) => {
        if (method === 'session.event') {
          const seq = params.event.seq;
          if (!Number.isSafeInteger(seq))
            throw Error('NATIVE_EVENT_SEQUENCE_INVALID');
          if ((this.forwardedSequences.get(params.sessionId) ?? -1) >= seq)
            return;
          this.forwardedSequences.set(params.sessionId, seq);
        }
        transport.notify(method, params);
      },
    };
    // SDK shutdown removes its listeners before disposing managed descendants.
    // Keep the public durable event channel alive through the existing drain;
    // per-Session sequence de-duplication prevents double publication while SDK is live.
    this.ownDisposers.push(
      ctx.on('session/event', (session, event) =>
        this.sdkTransport.notify('session.event', {
          sessionId: String(session.id),
          event,
        }),
      ),
    );
    this.sdk = new HarnessSdkJsonRpcServer(ctx, this.sdkTransport, options);
  }
  async initializeSdk(params) {
    if (this.terminated || this.phase !== 'uninitialized')
      throw Error('SDK_ALREADY_INITIALIZED');
    // Normalize only the new SDK working directory, never a persisted storage
    // namespace or restored header. Runtime-context snapshot messages remain
    // native context, separate from the attributed human input.
    const initialized = { ...params, cwd: await realpath(params.cwd) };
    if (this.terminated || this.phase !== 'uninitialized')
      throw Error('SESSION_CLOSING');
    const epoch = this.epoch;
    this.phase = 'initializing';
    this.initializing = this.sdk.initialize(initialized);
    try {
      await this.initializing;
      if (
        this.terminated ||
        this.epoch !== epoch ||
        this.phase !== 'initializing'
      )
        throw Error('SESSION_CLOSING');
      this.initializeParams = globalThis.structuredClone(initialized);
      this.phase = 'idle';
      this.initialized = true;
    } finally {
      this.initializing = undefined;
    }
  }
  isRootCurrent(record, sessionId) {
    return (
      !!record &&
      !this.terminated &&
      this.phase === 'ready' &&
      this.roots.get(sessionId) === record &&
      record.epoch === this.epoch &&
      this.ctx.agents.get(SessionId(sessionId)) === record.agent &&
      this.ctx.sessions.get(SessionId(sessionId)) === record.agent.session
    );
  }
  requireRoot(sessionId) {
    if (this.detaching !== undefined) throw Error('QUESTION_DETACHING');
    const record = this.roots.get(sessionId);
    if (!this.isRootCurrent(record, sessionId))
      throw Error('INPUT_SESSION_NOT_LIVE');
    return record;
  }
  assertRoot(record, sessionId) {
    if (this.requireRoot(sessionId) !== record)
      throw Error('INPUT_SESSION_NOT_LIVE');
  }
  async ensureRoot(sessionId, { resumeOnly = false } = {}) {
    if (
      this.terminated ||
      !this.initialized ||
      !sessionId ||
      typeof sessionId !== 'string'
    )
      throw Error('SDK_NOT_INITIALIZED');
    if (this.rootId && this.rootId !== sessionId)
      throw Error('HOST_SINGLE_ROOT_REQUIRED');
    if (this.phase === 'ready') return this.requireRoot(sessionId);
    if (!['idle', 'opening'].includes(this.phase))
      throw Error('INPUT_SESSION_NOT_LIVE');
    if (this.opening) return this.opening;
    this.rootId = sessionId;
    this.phase = 'opening';
    const epoch = this.epoch;
    this.opening = (async () => {
      let stored = true;
      try {
        await readStoredDshSession(this.ctx, sessionId);
      } catch (error) {
        if (
          resumeOnly ||
          error?.name !== 'SessionPersistenceNotFoundError' ||
          error.sessionId !== sessionId
        )
          throw error;
        stored = false;
      }
      if (this.epoch !== epoch || this.phase !== 'opening')
        throw Error('SESSION_CLOSING');
      if (stored) await this.sdk.resume({ sessionId });
      else await this.sdk.getWorkingDirectory({ sessionId });
      if (this.epoch !== epoch || this.phase !== 'opening')
        throw Error('SESSION_CLOSING');
      const agent = this.ctx.agents.get(SessionId(sessionId));
      if (
        !agent ||
        this.ctx.sessions.get(SessionId(sessionId)) !== agent.session
      )
        throw Error('SDK_ROOT_NOT_OWNED');
      const record = { agent, epoch };
      this.roots.set(sessionId, record);
      this.phase = 'ready';
      return record;
    })();
    try {
      return await this.opening;
    } catch (error) {
      if (this.phase !== 'closing') this.phase = 'failed';
      throw error;
    } finally {
      this.opening = undefined;
    }
  }
  async compactRoot(sessionId) {
    if (!this.roots.has(sessionId))
      return { compacted: false, reason: 'session_not_live' };
    const record = this.requireRoot(sessionId);
    const result = await this.ctx.compaction.compactNow(
      record.agent,
      new AbortController().signal,
    );
    return {
      compacted: result !== null,
      ...(result === null
        ? { reason: 'no_safe_range' }
        : { compactionId: String(result.compactionId) }),
    };
  }
  async waitRoot(sessionId) {
    this.requireRoot(sessionId);
    return this.sdk.wait({ sessionId });
  }
  async closeRoot(sessionId) {
    if (this.rootId && this.rootId !== sessionId)
      throw Error('HOST_SINGLE_ROOT_REQUIRED');
    if (this.phase === 'closed' && !this.recovering) return { closed: false };
    if (this.closing) {
      // A later external close also invalidates a recovery waiting on this
      // same preceding drain; it must not resurrect after the close returns.
      if (this.recovering) this.epoch++;
      return this.closing;
    }
    const recovery = this.recovering;
    this.phase = 'closing';
    this.epoch++;
    this.closing = (async () => {
      await this.initializing?.catch(() => {});
      await this.opening?.catch(() => {});
      await recovery?.catch(() => {});
      // Registry visibility is not ownership. Only the successfully adopted
      // record may receive an explicit cancellation/flush; an opening/failed
      // SDK disposes its own handles through its public shutdown below.
      const record = this.roots.get(sessionId);
      const agent =
        record &&
        this.ctx.agents.get(SessionId(sessionId)) === record.agent &&
        this.ctx.sessions.get(SessionId(sessionId)) === record.agent.session
          ? record.agent
          : undefined;
      if (agent) {
        agent.cancel({ kind: 'user' }, { keepInbox: true });
        await agent.whenIdle();
        await this.taskProgress?.flush();
        await this.ctx.sessions.flush(agent.session);
      }
      await this.sdk.shutdown();
      this.roots.clear();
      this.phase = 'closed';
      return { closed: !!agent };
    })();
    try {
      return await this.closing;
    } catch (error) {
      this.phase = 'failed';
      throw error;
    } finally {
      this.closing = undefined;
    }
  }
  async recoverRoot(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId)
      throw Error('INPUT_SESSION_NOT_LIVE');
    if (this.terminated || !this.initialized || this.phase === 'failed')
      throw Error('SDK_ROOT_FAILED');
    if (this.rootId && this.rootId !== sessionId)
      throw Error('HOST_SINGLE_ROOT_REQUIRED');
    if (this.recovering) return this.recovering;
    this.rootId = sessionId;
    // Capture the preceding close before publishing this recovery operation;
    // closeRoot then never waits on a recovery that is waiting on itself.
    const preceding =
      this.phase === 'closed' ? Promise.resolve() : this.closeRoot(sessionId);
    const epoch = this.epoch;
    const recovery = (async () => {
      await preceding;
      if (this.terminated || this.epoch !== epoch || this.phase !== 'closed')
        throw Error('SESSION_CLOSING');
      this.phase = 'recovering';
      const sdk = new HarnessSdkJsonRpcServer(
        this.ctx,
        this.sdkTransport,
        this.sdkOptions,
      );
      this.sdk = sdk;
      try {
        await sdk.initialize(this.initializeParams);
        if (
          this.terminated ||
          this.epoch !== epoch ||
          this.phase !== 'recovering'
        )
          throw Error('SESSION_CLOSING');
        this.phase = 'idle';
        return await this.ensureRoot(sessionId, { resumeOnly: true });
      } catch (error) {
        await sdk.shutdown();
        if (this.phase !== 'closing' && !this.terminated) this.phase = 'failed';
        throw error;
      }
    })();
    this.recovering = recovery;
    try {
      return await recovery;
    } finally {
      if (this.recovering === recovery) this.recovering = undefined;
    }
  }
  async shutdown() {
    // Irreversible before the first await: an in-flight public initialize or
    // cold restore cannot reopen the root after shutdown has returned.
    this.terminated = true;
    await this.closeRoot(this.rootId);
    while (this.ownDisposers.length) this.ownDisposers.pop()();
    return {};
  }
}
