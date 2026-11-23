import { sameDEntryIdentity } from '@allrice/contracts';
import type { Context } from '@deepseek-ai/cordis';
import type { RemoteStreamHandle, TypertSchema } from '@deepseek-ai/dsh-typert-protocol';
import { TYPERT_REMOTE } from '@allrice/d-entry-principal/remote';
import { DEntryPrincipalIssueSchema, type DEntryPrincipalActivity, type DEntryPrincipalControlScope, type DEntryPrincipalIssue, type DEntryScopedStreamFrame, type ScopeFrame } from '@allrice/d-entry-principal/types';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {}); return { promise, resolve, reject };
}
const unknown = () => Error('PRINCIPAL_JOIN_UNKNOWN');
/** One reader for a native duplex handle. One-item handoff applies backpressure;
 * close discards business delivery but keeps consuming exact closed/end. */
class Relay<T extends ScopeFrame | DEntryScopedStreamFrame> {
  private item?: T;
  private changed = deferred<void>();
  private consumed = deferred<void>();
  private ended = false;
  private closing = false;
  private joined?: Promise<void>;
  private closed = false;
  private failure: unknown;
  readonly done: Promise<void>;
  constructor(private readonly handle: RemoteStreamHandle<T, 'close'>, private readonly scopeId: string, private readonly timeoutMs: number, parser: TypertSchema<T>, receive: (frame: T) => boolean) {
    this.done = (async () => {
      try {
        for await (const raw of handle) {
          const frame = parser.parse(raw);
          if (frame.scopeId !== scopeId || this.closed) throw unknown();
          if (frame.type === 'closed') { this.closed = true; continue; }
          if (!receive(frame) || this.closing) continue;
          this.item = frame; this.changed.resolve();
          await this.consumed.promise;
          this.consumed = deferred<void>();
        }
        if (!this.closed) throw unknown();
      } catch (error) { this.failure = error; throw error; }
      finally { this.ended = true; this.changed.resolve(); }
    })();
    void this.done.catch(() => {});
  }
  async next(): Promise<IteratorResult<T>> {
    while (true) {
      if (this.item) { const value = this.item; this.item = undefined; this.consumed.resolve(); return { done: false, value }; }
      if (this.ended) { if (this.failure) throw this.failure; return { done: true, value: undefined }; }
      await this.changed.promise; this.changed = deferred<void>();
    }
  }
  close(): Promise<void> {
    if (this.joined) return this.joined;
    this.joined = Promise.resolve().then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!this.ended) { this.handle.send('close'); this.handle.end(); }
        await Promise.race([this.done, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unknown()), this.timeoutMs); })]);
        if (!this.closed) throw unknown();
      } catch { await this.local(); throw unknown(); }
      finally { if (timer) clearTimeout(timer); }
    });
    this.closing = true; this.item = undefined; this.consumed.resolve(); this.changed.resolve();
    return this.joined;
  }
  async local() {
    this.closing = true; this.item = undefined; this.consumed.resolve(); this.changed.resolve();
    this.handle.dispose(); await Promise.allSettled([this.done]);
  }
}

/** Owned Node client of the generated guest issuer; no snapshot/permission
 * callback is accepted. The shared owner supplies a separate cleanup carrier. */
export function createDEntryPrincipalControl(root: Context, input: { carrier: AbortSignal; cleanupTimeoutMs: number }) {
  if (!Number.isSafeInteger(input.cleanupTimeoutMs) || input.cleanupTimeoutMs <= 0) throw Error('PRINCIPAL_TIMEOUT_INVALID');
  const activities = new Set<DEntryPrincipalActivity & { local(): Promise<void>; fence(reason?: unknown): void }>();
  let stopped = false, closing: Promise<void> | undefined;
  const control = {
    acquire(value: DEntryPrincipalIssue, caller: AbortSignal): DEntryPrincipalActivity {
      if (stopped) throw Error('PRINCIPAL_CONTROL_CLOSED');
      caller.throwIfAborted(); input.carrier.throwIfAborted();
      const issue = DEntryPrincipalIssueSchema.parse(value);
      const revoked = new AbortController();
      let started = false;
      let relay: Relay<ScopeFrame> | undefined;
      let running: Promise<DEntryPrincipalControlScope> | undefined, joined: Promise<void> | undefined;
      const children = new Set<Relay<DEntryScopedStreamFrame>>();
      const operations = new Set<Promise<unknown>>();
      let detachRun = () => {};
      let published = false;
      const opened = deferred<Extract<ScopeFrame, { type: 'opened' }>>();
      const activity = {
        fence(reason?: unknown) { revoked.abort(reason); },
        run(signal: AbortSignal) {
          if (joined || revoked.signal.aborted) return Promise.reject(Error('PRINCIPAL_SCOPE_CLOSED'));
          if (running) return running;
          const business = AbortSignal.any([caller, signal, revoked.signal]);
          const cancelled = () => { void activity.close().catch(() => {}); };
          business.addEventListener('abort', cancelled, { once: true });
          detachRun = () => business.removeEventListener('abort', cancelled);
          running = Promise.resolve().then(async () => {
            business.throwIfAborted(); if (stopped) throw Error('PRINCIPAL_CONTROL_CLOSED');
            started = true;
            const handle = TYPERT_REMOTE.methods['allricePrincipal/openScope'].invoke(root.remote, { issue }, input.carrier);
            relay = new Relay(handle, issue.scopeId, input.cleanupTimeoutMs, TYPERT_REMOTE.methods['allricePrincipal/openScope'].result.create(), (frame) => {
              if (frame.type !== 'opened' || frame.baseline.owner || frame.principal.scopeId !== issue.scopeId || !sameDEntryIdentity(frame.principal.identity, issue.identity) || published) throw Error('PRINCIPAL_OPEN_INVALID');
              published = true; opened.resolve(frame); return false;
            });
            void relay.done.then(() => opened.reject(unknown()), (error) => opened.reject(error));
            if (business.aborted || joined) void relay.close().catch(() => {});
            const first = await opened.promise; business.throwIfAborted();
            return {
              opened: first, revoked: business,
              invoke(call, active) {
                business.throwIfAborted(); active.throwIfAborted();
                if (call.scopeId !== issue.scopeId) throw Error('PRINCIPAL_SCOPE_MISMATCH');
                const task = Promise.resolve().then(async () => {
                  business.throwIfAborted(); active.throwIfAborted();
                  const result = await TYPERT_REMOTE.methods['allricePrincipal/invokeScoped'].invoke(root.remote, { call }, AbortSignal.any([active, business]));
                  business.throwIfAborted(); active.throwIfAborted();
                  if (!result.ok) throw result.error;
                  const value = TYPERT_REMOTE.methods['allricePrincipal/invokeScoped'].result.create().parse(result.value);
                  if (value.endpoint !== call.endpoint) throw Error('PRINCIPAL_REMOTE_RESULT_INVALID');
                  return value;
                });
                operations.add(task);
                void task.then(() => operations.delete(task), () => operations.delete(task));
                return task;
              },
              stream(call, active) {
                business.throwIfAborted(); active.throwIfAborted();
                if (call.scopeId !== issue.scopeId) throw Error('PRINCIPAL_SCOPE_MISMATCH');
                const handle = TYPERT_REMOTE.methods['allricePrincipal/streamScoped'].invoke(root.remote, { call }, input.carrier);
                const child = new Relay(handle, issue.scopeId, input.cleanupTimeoutMs, TYPERT_REMOTE.methods['allricePrincipal/streamScoped'].result.create(), () => true);
                children.add(child);
                const cancelled = () => { void child.close().catch(() => {}); };
                const current = AbortSignal.any([business, active]);
                current.addEventListener('abort', cancelled, { once: true });
                void child.done.then(() => {
                  children.delete(child); current.removeEventListener('abort', cancelled);
                }, () => { current.removeEventListener('abort', cancelled); });
                if (current.aborted) cancelled();
                let taken = false;
                return {
                  async *[Symbol.asyncIterator]() {
                    if (taken) throw Error('PRINCIPAL_STREAM_ALREADY_CONSUMED');
                    taken = true;
                    try {
                      while (true) {
                        current.throwIfAborted();
                        const next = await child.next();
                        current.throwIfAborted();
                        if (next.done) return;
                        if (next.value.type === 'item') yield next.value;
                      }
                    } finally { await child.close(); current.removeEventListener('abort', cancelled); }
                  },
                };
              },
              close: activity.close,
            } satisfies DEntryPrincipalControlScope;
          });
          void running.catch(() => {});
          void running.then(() => {}, () => { business.removeEventListener('abort', cancelled); });
          return running;
        },
        close(): Promise<void> {
          if (joined) return joined;
          joined = Promise.resolve().then(async () => {
            // A run queued but not dispatched sees revoked before opening.
            if (!started) { await Promise.allSettled([running]); activities.delete(activity); return; }
            if (!relay) throw unknown();
            const results = await Promise.allSettled([...children].map((child) => child.close()).concat([relay.close()]));
            while (operations.size) await Promise.allSettled([...operations]);
            await Promise.allSettled([running]);
            detachRun();
            if (results.some((r) => r.status === 'rejected')) throw unknown();
            activities.delete(activity);
          });
          revoked.abort(); return joined;
        },
        async local() {
          revoked.abort();
          const results = await Promise.allSettled([
            ...[...children].map((child) => child.local()), relay?.local(),
          ]);
          while (operations.size) await Promise.allSettled([...operations]);
          await Promise.allSettled([running, joined]); detachRun();
          if (results.some((result) => result.status === 'rejected')) throw unknown();
        },
      };
      activities.add(activity);
      return activity;
    },
    fence(reason?: unknown) { stopped = true; for (const activity of activities) activity.fence(reason); },
    close() {
      if (closing) return closing;
      closing = Promise.resolve().then(async () => {
        const results = await Promise.allSettled([...activities].map((activity) => activity.close()));
        if (results.some((r) => r.status === 'rejected')) throw unknown();
      });
      control.fence(); return closing;
    },
    async drainLocal() {
      control.fence();
      const results = await Promise.allSettled([...activities].map((activity) => activity.local()));
      if (results.some((result) => result.status === 'rejected')) throw unknown();
    },
    async retireAfterNativeStop() { await control.drainLocal(); activities.clear(); },
  };
  return control;
}
