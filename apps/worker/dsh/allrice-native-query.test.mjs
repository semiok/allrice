/* global process, AbortController */
import { createHash } from 'node:crypto';
import { execFile, fork } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { chmod, readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { gate, hold, host, text } from '../test/native-subagent/fixture.mjs';
import {
  readNativeSubagentSummary,
  withNativeQueryReader,
} from './allrice-native-query.mjs';

async function files(root, readonly) {
  const result = [];
  async function visit(path) {
    const info = await stat(path);
    if (info.isDirectory()) {
      result.push([path.slice(root.length) + '/', info.mtimeMs, 'directory']);
      if (readonly !== undefined) await chmod(path, readonly ? 0o555 : 0o755);
      for (const name of (await readdir(path)).sort())
        await visit(join(path, name));
    } else {
      if (readonly !== undefined) await chmod(path, readonly ? 0o444 : 0o644);
      result.push([
        path.slice(root.length),
        info.mtimeMs,
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ]);
    }
  }
  await visit(root);
  return result;
}
const query = (h, id = h.root.id) =>
  h.server.handleRequest('session/subagent-summary', { sessionId: id });

it('shows the child result through the actual Host and reads the same cold summary without Agents, models, writes or leaked leases', async () => {
  // User intent: 查看子智能体的最后回复、耗时和用量。
  const h = await host({ model: async () => text('native child output') });
  const activation = await h.spawn();
  await activation.result;
  await h.wait();
  await h.ctx.sessions.flush(h.root.session);
  const live = await query(h);
  expect(live.root.source).toBe('live');
  expect(live.descendants).toMatchObject([
    {
      kind: 'child',
      id: activation.childId,
      activity: 'inactive',
      lastReply: 'native child output',
      usage: {
        uncachedInputTokens: 20,
        outputTokens: 7,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
  ]);
  const root = join(h.directory, 'sessions'),
    count = h.calls.length;
  const before = await files(root, true);
  try {
    await withNativeQueryReader(root, async (ctx) => {
      expect(ctx.get('agents')).toBeUndefined();
      expect(ctx.get('llm')).toBeUndefined();
      expect(ctx.sessions.list()).toHaveLength(0);
      const create = vi.spyOn(ctx.sessions, 'create');
      const open = vi.spyOn(ctx.sessionPersistence, 'open');
      const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery);
      let held = 0,
        abort,
        calls = 0;
      vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(
        async (...args) => {
          const observation = await observe(...args);
          held++;
          if (abort && ++calls === 2) abort.abort();
          return {
            ...observation,
            [Symbol.dispose]() {
              held--;
              observation[Symbol.dispose]();
            },
          };
        },
      );
      const cold = await readNativeSubagentSummary(ctx, h.root.id);
      expect(cold.root.source).toBe('prepared');
      expect(cold.descendants).toMatchObject([
        {
          kind: 'child',
          activity: 'unknown',
          observation: { source: 'prepared' },
          lastReply: 'native child output',
        },
      ]);
      expect(cold.descendants[0].usage).toEqual(live.descendants[0].usage);
      expect(cold.descendants[0].timing.settledMs).toBeGreaterThanOrEqual(0);
      expect(held).toBe(0);
      expect(create).not.toHaveBeenCalled();
      expect(open.mock.calls.length).toBeGreaterThan(0);
      expect(open.mock.calls.every((call) => call[1] === 'read')).toBe(true);
      expect(ctx.sessions.list()).toHaveLength(0);
      abort = new AbortController();
      await expect(
        readNativeSubagentSummary(ctx, h.root.id, abort.signal),
      ).rejects.toBeDefined();
      expect(held).toBe(0);
    });
    expect(await files(root)).toEqual(before);
    expect(h.calls).toHaveLength(count);
  } finally {
    await files(root, false);
  }
});

it('keeps an actual running Host live while a different process sees only a prepared prefix with synthetic closers', async () => {
  const entered = gate(),
    release = gate();
  const h = await host({
    model: async (request) => {
      if (request.sessionId !== 'pr0-root') {
        entered.resolve();
        await hold(request.signal, release);
      }
      return text('settled output');
    },
  });
  const activation = await h.spawn();
  try {
    await entered.promise;
    const child = h.ctx.agents.get(activation.childId);
    await h.ctx.sessions.flush(child.session);
    await h.ctx.sessions.flush(h.root.session);
    const live = await query(h);
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        resolve(
          import.meta.dirname,
          '../test/native-subagent/query-reader.mjs',
        ),
        join(h.directory, 'sessions'),
        h.root.id,
      ],
      { timeout: 15000 },
    );
    const cold = JSON.parse(stdout);
    expect(live.descendants[0]).toMatchObject({
      kind: 'child',
      activity: 'running',
      observation: { source: 'live' },
    });
    expect(live.descendants[0].timing.active).toBeDefined();
    expect(cold.descendants[0]).toMatchObject({
      kind: 'child',
      activity: 'unknown',
      observation: { source: 'prepared' },
    });
    expect(cold.descendants[0].observation.cursor).toBeGreaterThan(
      live.descendants[0].observation.cursor,
    );
    expect(cold.descendants[0].timing.lastTurnCompleted).toBe(false);
    expect((await query(h)).descendants[0].activity).toBe('running');
  } finally {
    release.resolve();
    await activation.result;
    await h.wait();
  }
});

it('refuses a foreign or closed Host root without creating or resuming a Session', async () => {
  const h = await host();
  const ensure = vi.spyOn(h.server, 'ensureRoot');
  expect((await query(h)).descendants).toEqual([]);
  await expect(query(h, 'foreign-root')).rejects.toThrow(
    'INPUT_SESSION_NOT_LIVE',
  );
  await h.server.closeRoot(h.root.id);
  await expect(query(h)).rejects.toThrow('INPUT_SESSION_NOT_LIVE');
  expect(ensure).not.toHaveBeenCalled();
  expect(h.calls).toHaveLength(0);
  const persisted = await withNativeQueryReader(
    join(h.directory, 'sessions'),
    (ctx) => readNativeSubagentSummary(ctx, h.root.id),
  );
  expect(persisted.root.source).toBe('prepared');
  expect(persisted.descendants).toEqual([]);
});

it('uses only fork-owned output and requires an own descriptor rather than an inherited ancestor descriptor', async () => {
  const entered = gate(),
    release = gate();
  const h = await host({
    model: async (request) => {
      if (request.sessionId !== 'pr0-root') {
        entered.resolve();
        await hold(request.signal, release);
      }
      return text(
        request.sessionId === 'pr0-root'
          ? 'parent-only reply'
          : 'fork-only reply',
      );
    },
  });
  await h.prompt('先完成父级历史');
  await h.wait();
  const activation = await h.spawn(h.root, 'fork', { provider: 'fork' });
  try {
    await entered.promise;
    const summary = await query(h);
    expect(summary.descendants[0]).toMatchObject({
      kind: 'child',
      lastReply: null,
      usage: { uncachedInputTokens: 20, outputTokens: 7 },
    });
  } finally {
    release.resolve();
    await activation.result;
    await h.wait();
  }
  expect((await query(h)).descendants[0].lastReply).toBe('fork-only reply');
  const source = await h.ctx.sessionQuery.observeSession(activation.childId);
  try {
    const child = h.ctx.sessions.create('inherited-descriptor', {
      seed: source.events,
      inheritedEventCount: source.events.length,
      meta: { isSeeded: true, parentSession: h.root.id, cwd: h.directory },
    });
    h.root.session.append('subagent/catalog', {
      version: 0,
      childId: child.id,
      childCreatedAt: child.header.createdAt,
      mode: 'one-shot',
      label: 'fork',
    });
    expect((await query(h)).descendants.at(-1)).toMatchObject({
      kind: 'diagnostic',
      reason: 'identity_mismatch',
    });
  } finally {
    source[Symbol.dispose]();
  }
});

it('reads a SIGKILL journal without recovery or invented terminal activity and does not create an absent namespace', async () => {
  const h = await host();
  const child = fork(
    resolve(import.meta.dirname, '../test/native-subagent/recovery-host.mjs'),
    ['start', h.directory],
    {
      execArgv: [],
      env: { PATH: process.env.PATH },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const closed = once(child, 'exit');
  try {
    const [ready] = await Promise.race([
      once(child, 'message'),
      closed.then(() => {
        throw Error(stderr);
      }),
    ]);
    expect(ready.error).toBeUndefined();
    child.kill('SIGKILL');
    await closed;
    const root = join(h.directory, 'sessions'),
      before = await files(root);
    for (let read = 0; read < 2; read++) {
      const result = await withNativeQueryReader(root, (ctx) =>
        readNativeSubagentSummary(ctx, 'recovery-root'),
      );
      expect(result.descendants[0]).toMatchObject({
        id: ready.childId,
        kind: 'child',
        activity: 'unknown',
        observation: { source: 'prepared' },
        lastReply: null,
      });
    }
    expect(await files(root)).toEqual(before);
    const missing = join(h.directory, 'absent-namespace');
    await expect(
      withNativeQueryReader(missing, (ctx) =>
        readNativeSubagentSummary(ctx, 'missing'),
      ),
    ).rejects.toBeDefined();
    await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await closed;
  }
}, 30000);

it('preserves missing and corrupt branch diagnostics and rejects catalog/header/own-descriptor mismatches', async () => {
  const h = await host();
  const catalog = (parent, id, createdAt = 1) =>
    parent.append('subagent/catalog', {
      version: 0,
      childId: id,
      childCreatedAt: createdAt,
      mode: 'one-shot',
      label: 'child',
    });
  catalog(h.root.session, 'missing');
  for (const [id, parentSession, descriptor] of [
    ['foreign', 'other-parent', true],
    ['no-descriptor', h.root.id, false],
    ['corrupt', h.root.id, true],
  ]) {
    const child = h.ctx.sessions.create(id, {
      meta: { parentSession, createdAt: 1, cwd: h.directory },
    });
    if (descriptor)
      child.append('subagent/descriptor', {
        version: 3,
        mode: 'one-shot',
        provider: 'spawn',
        label: 'child',
      });
    if (id === 'corrupt') child.append('subagent/catalog', { bad: true });
    if (id === 'foreign') catalog(child, 'descendant-of-untrusted-parent');
    // Test-only malformed fixtures use the public writer, never disk layout.
    const writer = await h.ctx.sessionPersistence.create(child.header);
    try {
      await writer.append(child.snapshotEvents());
      await writer.flush();
    } finally {
      await writer.close();
    }
    catalog(h.root.session, id);
  }
  const summary = await query(h);
  expect(summary.descendants).toMatchObject([
    { id: 'missing', kind: 'diagnostic', reason: 'unavailable' },
    { id: 'foreign', kind: 'diagnostic', reason: 'identity_mismatch' },
    {
      id: 'descendant-of-untrusted-parent',
      kind: 'diagnostic',
      reason: 'parent_unverified',
    },
    { id: 'no-descriptor', kind: 'diagnostic', reason: 'identity_mismatch' },
    { id: 'corrupt', kind: 'diagnostic', reason: 'corrupt' },
  ]);
  expect(h.calls).toHaveLength(0);
  for (const session of h.ctx.sessions.list())
    await h.ctx.sessions.flush(session);
  const root = join(h.directory, 'sessions'),
    before = await files(root);
  const cold = await withNativeQueryReader(root, (ctx) =>
    readNativeSubagentSummary(ctx, h.root.id),
  );
  expect(cold.descendants).toEqual(summary.descendants);
  expect(await files(root)).toEqual(before);
});
