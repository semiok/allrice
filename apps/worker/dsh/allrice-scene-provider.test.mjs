import { randomUUID } from 'node:crypto';
import { renderSkillContent } from '@deepseek-ai/dsh-skill';
import { expect, it } from 'vitest';
import { installSceneProvider } from './allrice-scene-provider.mjs';

function fixture() {
  const id = randomUUID(),
    digest = `sha256:${'a'.repeat(64)}`;
  const scene = {
    id,
    nativeName: `allrice-scene-${id}`,
    name: '周报',
    appliesWhen: '每周复盘',
    digest,
  };
  const receipt = { sceneId: id, sceneDigest: digest, receiptId: randomUUID() };
  const sessions = new Map(),
    listeners = new Map(),
    bridgeCalls = [];
  let provider, release;
  const adoption = new Promise((done) => {
    release = done;
  });
  const runtime = installSceneProvider(
    {
      skills: {
        registerProvider: (factory) => {
          provider = factory();
        },
      },
      on: (name, handler) => listeners.set(name, handler),
      sessions,
    },
    [scene],
    async (action, data) => {
      bridgeCalls.push({ action, data });
      if (action === 'load') return { receipt, content: 'PRIVATE_WEEK_ONLY' };
      await adoption;
      return { adopted: data };
    },
  );
  return {
    scene,
    receipt,
    sessions,
    listeners,
    bridgeCalls,
    provider,
    runtime,
    release,
  };
}
function events(name, result) {
  return [
    {
      type: 'tool/call',
      data: {
        name: 'skill',
        callId: 'restored-native-call',
        arguments: { name },
      },
    },
    {
      type: 'tool/result',
      data: {
        message: {
          content: [
            {
              type: 'tool-result',
              toolCallId: 'restored-native-call',
              isError: false,
              content: [{ type: 'text', text: result }],
            },
          ],
        },
      },
    },
  ];
}

it('restored child adoption blocks dispatch and never attributes fork-inherited parent results to the child', async () => {
  const first = fixture();
  const skill = await first.provider.get((await first.provider.list())[0]);
  const saved = events(first.scene.nativeName, renderSkillContent(skill));
  // New host: no live get or result event has run. Use the exact durable receipt.
  const sessions = new Map(),
    calls = [],
    listeners = new Map();
  let release;
  const blocked = new Promise((done) => {
    release = done;
  });
  const runtime = installSceneProvider(
    {
      skills: { registerProvider: () => {} },
      on: (name, fn) => listeners.set(name, fn),
      sessions,
    },
    [first.scene],
    async (action, data) => {
      calls.push({ action, data });
      if (action === 'load')
        return { receipt: first.receipt, content: 'PRIVATE_WEEK_ONLY' };
      await blocked;
      return { adopted: data };
    },
  );
  sessions.set('fork-with-no-own-read', {
    id: 'fork-with-no-own-read',
    ownEvents: () => [],
    snapshotEvents: () => saved,
  });
  await runtime.beforeDispatch('fork-with-no-own-read');
  expect(calls).toEqual([]);
  sessions.set('restored-child', {
    id: 'restored-child',
    ownEvents: () => saved,
    snapshotEvents: () => {
      throw Error('must not use inherited events');
    },
  });
  let dispatched = false;
  const wait = runtime.beforeDispatch('restored-child').then(() => {
    dispatched = true;
  });
  await expect.poll(() => calls.length).toBe(2);
  expect(dispatched).toBe(false);
  expect(calls[1].data).toMatchObject({
    ...first.receipt,
    nativeSessionId: 'restored-child',
    callId: 'restored-native-call',
  });
  release();
  await wait;
  await runtime.beforeDispatch('restored-child');
  expect(calls).toHaveLength(2);
});

it('rejects a modified native receipt instead of adopting text or an unrelated successful tool', async () => {
  const f = fixture(),
    skill = await f.provider.get((await f.provider.list())[0]);
  const session = {
    id: 'root',
    ownEvents: () =>
      events(
        f.scene.nativeName,
        renderSkillContent(skill).replace('PRIVATE_WEEK_ONLY', 'TAMPERED'),
      ),
  };
  f.sessions.set(session.id, session);
  await expect(f.runtime.beforeDispatch(session.id)).rejects.toThrow(
    'employee_scene_native_result_invalid',
  );
  expect(f.bridgeCalls.map((c) => c.action)).toEqual(['load']);
});
