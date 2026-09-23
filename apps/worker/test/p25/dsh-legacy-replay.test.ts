import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { legacySessionFixture } from './legacy-session-fixture.js';
import manifest from '../../src/harness/fixtures/dsh-legacy-v0/manifest.json' with { type: 'json' };

const fixtureRoot = resolve(
  import.meta.dirname,
  '../../src/harness/fixtures/dsh-legacy-v0',
);

async function journal(file: string) {
  const entry = manifest.files.find((entry) => entry.file === file)!;
  const text = await readFile(join(fixtureRoot, file), 'utf8');
  expect(createHash('sha256').update(text).digest('hex')).toBe(entry.sha256);
  return { text, sessionId: entry.sessionId };
}

async function install(root: string, sessionId: string, text: string) {
  const path = join(
    root,
    'sessions',
    '--allrice-legacy-fixture--',
    sessionId,
    'session.jsonl',
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return path;
}

async function migratedJournal(path: string, original: string) {
  expect(await readFile(path, 'utf8')).toBe(original);
  const rows = (await readFile(join(dirname(path), 'session.v3.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(rows[0].version).toBe(3);
  const oldPrivate = original
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((event) => event.type.startsWith('allrice/'));
  for (const old of oldPrivate) {
    const migrated = rows.find(
      (event) => event.type === old.type && event.time === old.time,
    );
    expect(migrated?.data).toEqual(old.data);
  }
  return rows;
}

function questionAnswer(text: string) {
  const checkpoint = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((event) => event.type === 'allrice/wait/checkpoint').data as {
    sessionId: string;
    questionId: string;
    turnId: string;
  };
  return {
    sessionId: checkpoint.sessionId,
    questionId: checkpoint.questionId,
    turnId: checkpoint.turnId,
    inputId: manifest.answerId,
    text: `allrice:user-question:v1:${JSON.stringify({ questionId: checkpoint.questionId, answers: [{ id: 'choice', selected: ['Continue'] }] })}`,
  };
}

describe('DSH immutable legacy session replay', () => {
  it('keeps one native writer across migration and releases its lease on close', async () => {
    const fixture = await legacySessionFixture(async () => ({
      text: 'Unexpected',
    }));
    try {
      const old = await journal('parked-question.jsonl');
      const path = await install(fixture.root, old.sessionId, old.text);
      const first = await fixture.runtime();
      const second = await fixture.runtime();
      await first.client.recover(old.sessionId);
      await expect(second.client.recover(old.sessionId)).rejects.toThrow();
      expect(fixture.requests).toHaveLength(0);
      expect(await readFile(path, 'utf8')).toBe(old.text);
      await first.client.close();
      await expect(second.client.recover(old.sessionId)).resolves.toMatchObject(
        { recovered: true },
      );
      expect(fixture.requests).toHaveLength(0);
      await second.client.close();
      await migratedJournal(path, old.text);
    } finally {
      await fixture.close();
    }
  }, 30000);

  it('resumes historical tool messages without re-executing their callbacks', async () => {
    const fixture = await legacySessionFixture(async () => ({
      text: 'Legacy history retained.',
    }));
    try {
      const old = await journal('ordinary-tool.jsonl');
      const path = await install(fixture.root, old.sessionId, old.text);
      const { client, notices } = await fixture.runtime();
      const callbacks: string[] = [];
      client.setRequestHandler(async (method) => {
        callbacks.push(method);
        throw new Error('Historical tools must never be dispatched');
      });
      await expect(client.recover(old.sessionId)).resolves.toMatchObject({
        recovered: true,
      });
      expect(fixture.requests).toHaveLength(0);
      const receipt = await client.prompt(
        old.sessionId,
        'Continue from history.',
      );
      expect(receipt).toBeTruthy();
      await expect
        .poll(() =>
          notices.some(
            (n) => n.method === 'session.status' && n.params.status === 'idle',
          ),
        )
        .toBe(true);
      expect(fixture.requests).toHaveLength(1);
      expect(callbacks).toEqual([]);
      const messages = fixture.requests[0]!.messages;
      expect(JSON.stringify(messages)).toContain('synthetic-history-result');
      expect(JSON.stringify(messages)).toContain(
        'Historical tool result recorded.',
      );
      expect(
        messages.filter((message) => message.role === 'tool'),
      ).toHaveLength(1);
      await client.close();
      await migratedJournal(path, old.text);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it.each(['parked-question.jsonl', 'answered-question.jsonl'])(
    'adopts the exact answer from %s and continues once',
    async (file) => {
      const fixture = await legacySessionFixture(async () => ({
        text: 'Legacy question continued.',
      }));
      try {
        const old = await journal(file);
        const path = await install(fixture.root, old.sessionId, old.text);
        const { client, notices } = await fixture.runtime();
        const answer = questionAnswer(old.text);
        await client.recover(old.sessionId);
        await expect(
          client.answerWait({ ...answer, turnId: `${old.sessionId}:turn:999` }),
        ).rejects.toThrow('NATIVE_WAIT_CHANGED');
        const receipt = await client.answerWait(answer);
        expect(receipt.proof).toMatchObject({
          status: 'adopted',
          inputId: answer.inputId,
          turnId: answer.turnId,
          checkpoint: 'question_resolved',
        });
        expect((await client.answerWait(answer)).proof).toEqual(receipt.proof);
        await expect(
          client.answerWait({ ...answer, text: `${answer.text} ` }),
        ).rejects.toThrow('INPUT_ID_CONFLICT');
        expect(fixture.requests).toHaveLength(0);
        await client.continueWait(answer);
        await expect
          .poll(() =>
            notices.some(
              (n) =>
                n.method === 'session.status' && n.params.status === 'idle',
            ),
          )
          .toBe(true);
        expect(fixture.requests).toHaveLength(1);
        const messages = fixture.requests[0]!.messages;
        expect(JSON.stringify(messages.at(-1))).toContain(
          'Continue the existing task',
        );
        expect(JSON.stringify(messages.at(-1))).toContain(
          'This answer is not action approval',
        );
        expect(
          messages.filter((message) =>
            JSON.stringify(message).includes(
              'Ask before continuing the synthetic task.',
            ),
          ),
        ).toHaveLength(1);
        await expect(client.continueWait(answer)).rejects.toThrow(
          'NATIVE_WAIT_CHANGED',
        );
        expect(fixture.requests).toHaveLength(1);
        await client.close();
        await migratedJournal(path, old.text);
        const restarted = await fixture.runtime();
        await restarted.client.recover(old.sessionId);
        await expect(restarted.client.continueWait(answer)).rejects.toThrow(
          'NATIVE_WAIT_CHANGED',
        );
        expect(fixture.requests).toHaveLength(1);
      } finally {
        await fixture.close();
      }
    },
    30_000,
  );

  it('does not replay a continuation already dispatched by the historical runtime', async () => {
    const fixture = await legacySessionFixture(async () => ({
      text: 'Unexpected',
    }));
    try {
      const old = await journal('continued-question.jsonl');
      await install(fixture.root, old.sessionId, old.text);
      const { client } = await fixture.runtime();
      await client.recover(old.sessionId);
      await expect(
        client.continueWait(questionAnswer(old.text)),
      ).rejects.toThrow('NATIVE_WAIT_CHANGED');
      await client.close();
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it.each(['future-format', 'unknown-required-event'])(
    'refuses %s without rewriting the journal or dispatching a model',
    async (kind) => {
      const fixture = await legacySessionFixture(async () => ({
        text: 'Unexpected',
      }));
      try {
        const old = await journal('ordinary-tool.jsonl');
        const rows = old.text
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        if (kind === 'future-format') rows[0].version = 999;
        else rows[1].type = 'allrice/unknown-required-fixture';
        const text = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
        const path = await install(fixture.root, old.sessionId, text);
        const { client } = await fixture.runtime();
        await expect(client.recover(old.sessionId)).rejects.toMatchObject({
          code: 'DSH_REQUEST_FAILED',
        });
        await client.close();
        expect(fixture.requests).toHaveLength(0);
        expect(await readFile(path, 'utf8')).toBe(text);
      } finally {
        await fixture.close();
      }
    },
    30_000,
  );

  it.each([
    'malformed-digest',
    'foreign-checkpoint',
    'unbound-answer',
    'unbound-continuation',
  ])(
    'refuses %s before publishing a migrated generation',
    async (kind) => {
      const fixture = await legacySessionFixture(async () => ({
        text: 'Unexpected',
      }));
      try {
        const old = await journal('continued-question.jsonl');
        const rows = old.text
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        if (kind === 'malformed-digest')
          rows.find((e) => e.type === 'allrice/input/request').data.digest =
            'invalid';
        if (kind === 'foreign-checkpoint')
          rows.find(
            (e) => e.type === 'allrice/wait/checkpoint',
          ).data.sessionId = 'another-session';
        if (kind === 'unbound-answer')
          rows.find((e) => e.type === 'allrice/input/answered').data.inputId =
            '22222222-2222-4222-8222-222222222222';
        if (kind === 'unbound-continuation')
          rows.find((e) => e.type === 'allrice/wait/continued').data.inputId =
            '22222222-2222-4222-8222-222222222222';
        const text = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
        const path = await install(fixture.root, old.sessionId, text);
        const { client } = await fixture.runtime();
        await expect(client.recover(old.sessionId)).rejects.toMatchObject({
          code: 'DSH_REQUEST_FAILED',
        });
        await client.close();
        expect(fixture.requests).toHaveLength(0);
        expect(await readFile(path, 'utf8')).toBe(text);
        expect(await readdir(dirname(path))).not.toContain('session.v3.jsonl');
      } finally {
        await fixture.close();
      }
    },
    30_000,
  );
});
