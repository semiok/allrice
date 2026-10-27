/* global process, AbortController */
import { fork } from 'node:child_process';
import { once } from 'node:events';
import {
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

it('T16 fork inherits completed history and excludes the current root turn', async () => {
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
