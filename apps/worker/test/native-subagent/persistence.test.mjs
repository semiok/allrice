/* global process, AbortController */
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { gate, hold, host, text } from './fixture.mjs';
import { toolResult } from './tool-result.mjs';
import golden from './golden/manifest.json' with { type: 'json' };

it('T5 excludes a second writer, then cold-resumes after SIGKILL without replay', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pr0-crash-')));
  const children = [];
  function launch(mode, childId = '') {
    const child = fork(
      resolve(import.meta.dirname, 'recovery-host.mjs'),
      [mode, directory, childId],
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
    const message = new Promise((done, reject) => {
      child.once('message', done);
      child.once('exit', (code) => {
        reject(Error(`recovery child exited ${code}: ${stderr}`));
      });
    });
    children.push({ child, closed });
    return { child, closed, message };
  }
  try {
    await symlink(
      resolve(import.meta.dirname, '../../node_modules'),
      join(directory, 'node_modules'),
    );
    await writeFile(
      join(directory, 'credentials.yml'),
      '{"version":1,"records":{}}',
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, 'profile.yml'),
      (await readFile(
        resolve(import.meta.dirname, '../../dsh/allrice-restricted.cordis.yml'),
        'utf8',
      )) +
        '\n' +
        (await readFile(
          resolve(import.meta.dirname, 'plugins.cordis.yml'),
          'utf8',
        )),
    );
    const first = launch('start');
    const ready = await first.message;
    expect(ready.childId).toBeTypeOf('string');
    const competing = launch('resume', ready.childId);
    expect(await competing.message).toMatchObject({
      error: { message: expect.stringMatching(/writ|lock|held/i) },
    });
    await competing.closed;
    first.child.kill('SIGKILL');
    await first.closed;
    const resumed = launch('resume', ready.childId);
    const result = await resumed.message;
    expect(result.error).toBeUndefined();
    expect(result.before.requests).toBe(0);
    expect(result.before.descendants).toMatchObject([
      { id: ready.childId, activity: 'inactive' },
    ]);
    expect(result.notices).toBe(1);
    expect(result.turns).toEqual(['interrupted', 'completed']);
    expect(result.requests.filter((id) => id === ready.childId)).toHaveLength(
      1,
    );
    await resumed.closed;
  } finally {
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await closed;
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

it('T11 native tokenUsage stays per session, including a cold child', async () => {
  const h = await host();
  const child = await h.spawn();
  await child.result;
  await h.wait();
  for (const id of [h.root.id, child.childId]) {
    const observation = await h.ctx.sessionQuery.observeSession(id);
    try {
      const steps = h.calls.filter((r) => r.sessionId === id).length;
      expect(observation.projections.values.tokenUsage).toEqual({
        uncachedInputTokens: steps * 20,
        outputTokens: steps * 7,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    } finally {
      observation[Symbol.dispose]();
    }
  }
});

it('fork inherits completed history and excludes the current root turn (scenario 19)', async () => {
  const entered = gate(),
    finish = gate();
  let rootSteps = 0;
  const h = await host({
    model: async (r) => {
      if (r.sessionId === 'pr0-root' && ++rootSteps === 2) {
        entered.resolve();
        await hold(r.signal, finish);
      }
      return text('完成');
    },
  });
  await h.prompt('已完成历史 PR0_HISTORY');
  await h.wait();
  await h.prompt('尚未完成 PR0_CURRENT');
  await entered.promise;
  const child = await h.spawn(h.root, '分叉任务', { provider: 'fork' });
  await child.result;
  const request = h.calls.find((r) => r.sessionId === child.childId);
  expect(JSON.stringify(request.messages)).toContain('PR0_HISTORY');
  expect(JSON.stringify(request.messages)).not.toContain('PR0_CURRENT');
  finish.resolve();
  await h.wait();
  await h.ctx.subagents.sendMessage(
    h.root,
    child.childId,
    text('继续分叉任务'),
    { signal: new AbortController().signal },
  );
  await h.wait();
  expect(h.calls.filter((r) => r.sessionId === child.childId)).toHaveLength(2);
});

it('T16 cold-resumes native golden history and a queued notification without replaying tools', async () => {
  const journals = new Map();
  const h = await host({
    prepare: async (directory) => {
      for (const entry of golden.files) {
        const raw = await readFile(
          join(import.meta.dirname, 'golden', entry.file),
          'utf8',
        );
        expect(createHash('sha256').update(raw).digest('hex')).toBe(
          entry.sha256,
        );
        const journal = raw.replaceAll(
          golden.capturedWith.normalizedCwd,
          directory,
        );
        journals.set(entry.sessionId, journal);
        const folder = join(
          directory,
          'sessions',
          `-${directory.replaceAll('/', '-')}--`,
          entry.sessionId,
        );
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, 'session.v4.jsonl'), journal);
      }
    },
    model: async (r) =>
      text(
        r.sessionId === golden.childId ? '新的子级回复' : '继续处理历史结果',
      ),
  });
  const dispatched = [];
  h.ctx.tools.guard((exec) => {
    dispatched.push(exec.callId);
  });
  expect(h.calls).toHaveLength(0);
  expect(h.root.id).toBe(golden.rootId);
  expect(await h.ctx.subagents.listDescendants(h.root.id)).toMatchObject([
    { id: golden.childId, label: '黄金子任务', activity: 'inactive' },
  ]);
  expect(h.ctx.agents.get(golden.childId)).toBeUndefined();
  const pending = [...h.root.inbox.nextStep, ...h.root.inbox.nextTurn];
  expect(pending).toMatchObject([
    { source: { kind: 'subagent-settled', senderSessionId: golden.childId } },
  ]);
  expect(JSON.stringify(pending)).toContain('GOLDEN_CHILD_REPLY');

  await h.prompt('继续刚才的子智能体任务，先读已有结果。');
  await h.wait();
  const rootMessages = h.calls.find(
    (r) => r.sessionId === golden.rootId,
  ).messages;
  expect(JSON.stringify(rootMessages)).toContain('GOLDEN_ROOT_HISTORY');
  expect(toolResult(rootMessages, 'golden-spawn')).toMatchObject({
    isError: false,
  });
  expect(
    rootMessages.filter((m) => m.source?.kind === 'subagent-settled'),
  ).toHaveLength(1);

  await h.ctx.subagents.sendMessage(
    h.root,
    golden.childId,
    text('请根据上次结果再补一句。'),
    { signal: new AbortController().signal },
  );
  await h.wait();
  const childRequests = h.calls.filter((r) => r.sessionId === golden.childId);
  expect(childRequests).toHaveLength(1);
  expect(JSON.stringify(childRequests[0].messages)).toContain(
    'GOLDEN_CHILD_HISTORY',
  );
  expect(JSON.stringify(childRequests[0].messages)).toContain(
    'GOLDEN_CHILD_REPLY',
  );
  expect(
    toolResult(childRequests[0].messages, 'golden-child-list'),
  ).toMatchObject({ isError: false, content: text('(no subagents)') });
  expect(dispatched).toEqual([]);

  for (const [id, journal] of journals) {
    const observation = await h.ctx.sessionQuery.observeSession(id);
    try {
      const original = journal
        .trim()
        .split('\n')
        .slice(1)
        .map((line) => JSON.parse(line));
      expect(observation.events.slice(0, original.length)).toEqual(original);
      expect(
        observation.events.filter((e) => e.type === 'tool/call'),
      ).toHaveLength(1);
    } finally {
      observation[Symbol.dispose]();
    }
  }
  const events = h.root.session.snapshotEvents();
  expect(events.filter((e) => e.type === 'subagent/catalog')).toHaveLength(1);
  const notices = events.filter(
    (e) =>
      e.type === 'user/message' && e.data.source?.kind === 'subagent-settled',
  );
  expect(notices).toHaveLength(2);
  expect(notices[0].data.id).toBe(pending[0].id);
  expect(JSON.stringify(notices[1].data)).toContain('新的子级回复');
});
