import { createHash } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { expect, it } from 'vitest';
import {
  enqueuePersonalScenePrompt,
  installPersonalScenePromptAdmission,
} from './allrice-personal-scene-prompt.mjs';
import { readBootstrapCoverage } from './allrice-bootstrap-coverage.mjs';

it('admits all sources in one native step, preserving image, reference, receipt and identity', async () => {
  let queued = [];
  const calls = [];
  const agent = {
    send(message, target, wake) {
      calls.push({ target, wake });
      queued.push(message);
    },
    followup(message) {
      calls.push({ wake: true });
      queued.push(message);
    },
  };
  const human = '/weekly',
    parts = [
      { kind: 'allrice-context', text: 'Memory /memory' },
      { kind: 'user', text: human },
      { kind: 'allrice-context', text: 'Attachment /attachment' },
    ];
  const digest = `sha256:${createHash('sha256')
    .update(JSON.stringify({ role: 'user', text: human }))
    .digest('hex')}`;
  const entry = { key: 'user:ec45934d-86bb-476b-8b35-95792cc20e90', digest };
  const reference = createUserMessage({
    source: { kind: 'session-reference' },
    content: [{ type: 'text', text: '/reference' }],
  });
  const receipt = enqueuePersonalScenePrompt(
    agent,
    {
      personalScenePrompt: parts,
      bootstrapReceipt: { version: 1, scope: digest, imported: [entry] },
    },
    [
      { type: 'text', text: parts.map((p) => p.text).join('\n\n') },
      { type: 'image', source: { kind: 'synthetic' } },
    ],
    reference,
  );
  expect(calls.map((c) => c.wake)).toEqual([true]);
  expect(queued[0].source.kind).toBe('user');
  expect(queued[0].content[0].text).toBe(human);
  let preStep;
  installPersonalScenePromptAdmission({
    on(_name, handler) {
      preStep = handler;
    },
  });
  queued = (
    await preStep({}, async () => ({ kind: 'continue', messages: queued }))
  ).messages;
  expect(queued.map((m) => m.source.kind)).toEqual([
    'allrice-context',
    'user',
    'allrice-context',
    'session-reference',
  ]);
  expect(receipt.messageId).toBe(queued[1].id);
  expect(queued[1].content[1].type).toBe('image');
  expect(queued[3].id).toBe(reference.id);
  expect(
    readBootstrapCoverage(
      {
        snapshotEvents: () =>
          queued.map((data) => ({ type: 'user/message', data })),
      },
      { scope: digest, candidates: [entry] },
    ).covered,
  ).toEqual([entry]);
});

it('rejects tampered framing and multiple human origins before touching the native inbox', () => {
  const agent = {
    send() {
      throw Error('must not enqueue');
    },
    followup() {
      throw Error('must not enqueue');
    },
  };
  expect(() =>
    enqueuePersonalScenePrompt(
      agent,
      { personalScenePrompt: [{ kind: 'user', text: '/other' }] },
      [{ type: 'text', text: '/weekly' }],
    ),
  ).toThrow('employee_scene_prompt_source_invalid');
  expect(() =>
    enqueuePersonalScenePrompt(
      agent,
      {
        personalScenePrompt: [
          { kind: 'user', text: '/a' },
          { kind: 'user', text: '/b' },
        ],
      },
      [{ type: 'text', text: '/a\n\n/b' }],
    ),
  ).toThrow('employee_scene_prompt_source_invalid');
});
