import { Context, Service } from '@deepseek-ai/cordis';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import {
  SessionQueryEngine,
  type SessionObservation,
} from '@deepseek-ai/dsh-session-query';
import SubagentRuntime from '@deepseek-ai/dsh-subagent';
import Gateway from '@deepseek-ai/dsh-api-gateway';
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import TypertRegistry, {
  type TypertContribution,
} from '@deepseek-ai/dsh-typert-registry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NativeHistorySource from '@allrice/dsh-native-history-source';
import type { NativeHistoryCut } from './types.ts';

// Native transport test identity, never a production SaaS authority.
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    historySourceTest: { readonly kind: 'historySourceTest' };
  }
}

const contexts: Context[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()));
});
class Query extends SessionQueryEngine {
  override async searchSessions(): Promise<never> {
    throw new Error('search-not-used');
  }
  override async searchEvents(): Promise<never> {
    throw new Error('search-not-used');
  }
}
class Directory extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workingDirectory');
  }
}
async function fixture() {
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(Directory);
  await ctx.plugin(SubagentRuntime);
  await ctx.plugin(Query);
  await ctx.plugin(NativeHistorySource);
  const root = ctx.sessions.create(SessionId('root'), {
    meta: { createdAt: 1 },
  });
  const child = ctx.sessions.create(SessionId('child'), {
    meta: { createdAt: 2 },
  });
  root.append('subagent/catalog', {
    version: 0,
    childId: child.id,
    childCreatedAt: 2,
    mode: 'one-shot',
  });
  return { ctx, root, child, source: ctx.allriceHistorySource };
}
const signal = () => new AbortController().signal;
async function nativeGateway(ctx: Context) {
  await ctx.plugin(TypertRegistry);
  await ctx.plugin(RemoteAccess);
  await ctx.plugin(Gateway);
  const generatedPath = '../lib/typert.host.js';
  const { TYPERT } = await import(generatedPath);
  ctx.typert.register(TYPERT as TypertContribution);
  // A native in-process owner Peer tests protocol dispatch only. It is not
  // SaaS identity, a cold authority, HTTP auth or a production composition.
  const peer = new Peer(ctx, { principal: { kind: 'owner' } });
  return (active: AbortSignal) =>
    ctx.typertGateway.invoke({
      namespace: 'allriceHistory',
      method: 'readCut',
      args: { request: { rootSessionId: 'root' } },
      peer,
      signal: active,
    });
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('native fixed-cut exporter', () => {
  it('uses the real registered public catalog and query, without creating an Agent', async () => {
    const { ctx, root, child, source } = await fixture();
    expect(ctx.get('agents')).toBeUndefined();
    const cut = JSON.parse(
      await source.readCut({ rootSessionId: root.id }, signal()),
    ) as NativeHistoryCut;
    expect(cut.sessions.map((cut) => cut.meta.id)).toEqual([root.id, child.id]);
    expect(cut.sessions[0]!.catalog).toEqual([
      { id: child.id, createdAt: 2, mode: 'one-shot' },
    ]);
    using observation = await ctx.sessionQuery.observeSession(root.id, {
      signal: signal(),
    });
    expect(cut.sessions[0]!.events).toEqual(observation.events);
    expect(ctx.get('agents')).toBeUndefined();
  });
  it('materializes the same observation prefix and catalog even if the live log appends', async () => {
    const { ctx, root, source } = await fixture();
    const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery);
    const late = ctx.sessions.create(SessionId('late'), {
      meta: { createdAt: 3 },
    });
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(
      async (id, options) => {
        const observation = await observe(id, options);
        if (id === root.id)
          root.append('subagent/catalog', {
            version: 0,
            childId: late.id,
            childCreatedAt: 3,
            mode: 'one-shot',
          });
        return observation;
      },
    );
    const cut = JSON.parse(
      await source.readCut({ rootSessionId: root.id }, signal()),
    ) as NativeHistoryCut;
    expect(cut.sessions.map((row) => row.meta.id)).toEqual(['root', 'child']);
    expect(cut.sessions[0]!.events).toHaveLength(1);
  });
  it('disposes each real observation before the next session and before a reply settles', async () => {
    const { ctx, source } = await fixture();
    const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery);
    let open = 0;
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(
      async (...args) => {
        expect(open).toBe(0);
        const actual = await observe(...args);
        open++;
        return {
          ...actual,
          [Symbol.dispose]() {
            actual[Symbol.dispose]();
            open--;
          },
          retain: actual.retain.bind(actual),
        } as SessionObservation;
      },
    );
    await source.readCut({ rootSessionId: 'root' }, signal());
    expect(open).toBe(0);
  });
  it('joins a late cancelled observation and disposes it without dispatching a child read', async () => {
    const { ctx, source } = await fixture(),
      controller = new AbortController(),
      entered = gate(),
      finish = gate();
    const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery);
    const dispose = vi.fn();
    const spy = vi
      .spyOn(ctx.sessionQuery, 'observeSession')
      .mockImplementation(async (...args) => {
        const actual = await observe(...args);
        entered.release();
        await finish.promise;
        return {
          ...actual,
          [Symbol.dispose]() {
            actual[Symbol.dispose]();
            dispose();
          },
          retain: actual.retain.bind(actual),
        } as SessionObservation;
      });
    const work = source.readCut({ rootSessionId: 'root' }, controller.signal);
    await entered.promise;
    controller.abort();
    let done = false;
    void work.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    await Promise.resolve();
    expect(done).toBe(false);
    finish.release();
    await expect(work).rejects.toBeDefined();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('does not promote external/unknown branches or infer ancestry from a fork header', async () => {
    const { root, source, ctx } = await fixture();
    root.append('subagent/catalog', {
      version: 2,
      childId: SessionId('external'),
      childCreatedAt: 3,
      mode: 'external',
    });
    root.append('subagent/catalog', {
      version: 1,
      childId: SessionId('unknown'),
      childCreatedAt: 4,
      mode: 'unknown',
    });
    ctx.sessions.create(SessionId('fork-only'), {
      meta: { parentSession: root.id, createdAt: 5 },
    });
    const cut = JSON.parse(
      await source.readCut({ rootSessionId: 'root' }, signal()),
    ) as NativeHistoryCut;
    expect(cut.sessions.map((row) => row.meta.id)).toEqual(['root', 'child']);
    expect(cut.sessions[0]!.catalog.map((row) => row.mode)).toEqual([
      'one-shot',
      'external',
      'unknown',
    ]);
  });
  it('fails missing/cyclic local branches instead of returning an invented empty source', async () => {
    const { child, root, source } = await fixture();
    child.append('subagent/catalog', {
      version: 0,
      childId: root.id,
      childCreatedAt: 1,
      mode: 'one-shot',
    });
    await expect(
      source.readCut({ rootSessionId: 'root' }, signal()),
    ).rejects.toThrow('HISTORY_CUT_ANCESTRY_CONFLICT');
    await expect(
      source.readCut({ rootSessionId: 'absent' }, signal()),
    ).rejects.toBeDefined();
  });
  it('joins an in-flight native observation when its existing plugin lifetime closes', async () => {
    const { ctx, source } = await fixture(),
      entered = gate(),
      finish = gate(),
      aborted = gate();
    const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery);
    const dispose = vi.fn();
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(
      async (...args) => {
        const actual = await observe(...args);
        const active = args[1]?.signal;
        active?.addEventListener('abort', aborted.release, { once: true });
        if (active?.aborted) aborted.release();
        entered.release();
        await finish.promise;
        return {
          ...actual,
          [Symbol.dispose]() {
            actual[Symbol.dispose]();
            dispose();
          },
          retain: actual.retain.bind(actual),
        } as SessionObservation;
      },
    );
    const work = source.readCut({ rootSessionId: 'root' }, signal());
    await entered.promise;
    let joined = false;
    const closing = ctx.fiber.dispose().then(() => {
      joined = true;
    });
    await aborted.promise;
    expect(joined).toBe(false);
    finish.release();
    await expect(work).rejects.toBeDefined();
    await closing;
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(joined).toBe(true);
  });
  it('exposes only the official generated fixed readonly request/result contract', async () => {
    // The full-file gate builds through the official generator first. Variable
    // import avoids pretending a generated file already exists in source.
    const generatedPath = '../lib/typert.remote-client.js';
    const { TYPERT_REMOTE } = await import(generatedPath);
    expect(Object.keys(TYPERT_REMOTE.methods)).toEqual([
      'allriceHistory/readCut',
    ]);
    const method = TYPERT_REMOTE.methods['allriceHistory/readCut'];
    expect(
      method
        .input({ strict: true })
        .create()
        .parse({ request: { rootSessionId: 'root' } }),
    ).toEqual({ request: { rootSessionId: 'root' } });
    expect(() =>
      method
        .input({ strict: true })
        .create()
        .parse({ request: { rootSessionId: 'root', path: '/arbitrary' } }),
    ).toThrow();
  });
  it('roundtrips the actual cut through the generated Registry and public Remote Gateway', async () => {
    const { ctx, root, child } = await fixture();
    const invoke = await nativeGateway(ctx);
    const result = await invoke(signal());
    expect(typeof result).toBe('string');
    const cut = JSON.parse(result as string) as NativeHistoryCut;
    expect(cut.sessions.map((row) => row.meta.id)).toEqual([root.id, child.id]);
    using observation = await ctx.sessionQuery.observeSession(root.id, {
      signal: signal(),
    });
    expect(cut.sessions[0]!.events).toEqual(observation.events);
    expect(ctx.get('agents')).toBeUndefined();
  });
  it('joins a cancelled native observation before the real Gateway call rejects', async () => {
    const { ctx } = await fixture(),
      entered = gate(),
      finish = gate(),
      controller = new AbortController();
    const invoke = await nativeGateway(ctx);
    const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery),
      dispose = vi.fn();
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(
      async (...args) => {
        const actual = await observe(...args);
        entered.release();
        await finish.promise;
        return {
          ...actual,
          retain: actual.retain.bind(actual),
          [Symbol.dispose]() {
            actual[Symbol.dispose]();
            dispose();
          },
        } as SessionObservation;
      },
    );
    const work = invoke(controller.signal);
    let settled = false;
    void work.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await entered.promise;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    finish.release();
    await expect(work).rejects.toBeDefined();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(settled).toBe(true);
  });
  it('refuses a non-owner before observation even if native policy grants the endpoint', async () => {
    const { ctx } = await fixture();
    await nativeGateway(ctx);
    ctx.remoteAccess.registerPolicy('historySourceTest', {
      bindings: () => [
        {
          role: {
            name: 'test-only',
            resource: 'global',
            actions: ['allriceHistory/readCut'],
          },
          resource: { kind: 'global' },
        },
      ],
    });
    const peer = new Peer(ctx, { principal: { kind: 'historySourceTest' } });
    const observed = vi.spyOn(ctx.sessionQuery, 'observeSession');
    await expect(
      ctx.typertGateway.invoke({
        namespace: 'allriceHistory',
        method: 'readCut',
        args: { request: { rootSessionId: 'root' } },
        peer,
        signal: signal(),
      }),
    ).rejects.toThrow('HISTORY_CUT_OWNER_REQUIRED');
    expect(observed).not.toHaveBeenCalled();
  });
});
