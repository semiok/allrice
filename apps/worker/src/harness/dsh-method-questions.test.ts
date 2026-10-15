import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { methodActivationQuestionPrefix } from '@allrice/contracts';

const { preparedMethodQuestions } = await import(
  new URL('../../dsh/allrice-method-questions.mjs', import.meta.url).href
);
function fixture() {
  const cache = preparedMethodQuestions();
  const agent = {};
  const receiptId = randomUUID();
  const question = {
    id: methodActivationQuestionPrefix + receiptId,
    header: '公司工作方法',
    question: '启用这一确切版本？',
    detail: '公司、财务部和运营部的完整影响范围',
    options: [
      { label: '确认启用', description: '启用此版本' },
      { label: '暂不启用' },
    ],
    multiSelect: false,
  };
  const result = {
    receiptId,
    enabled: false,
    question,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const response = () => ({ modelContent: JSON.stringify(result) });
  const prepare = () => cache.complete(agent, cache.begin(agent), response());
  const native = { ...question, detail: undefined };
  return { cache, agent, question, result, response, prepare, native };
}
afterEach(() => vi.useRealTimers());

describe('server-authored method question presentation', () => {
  it('restores only the omitted detail once, leaving ordinary questions untouched', () => {
    const f = fixture();
    f.prepare();
    const ordinary = [{ id: 'choice', question: 'Which?' }];
    expect(f.cache.take(f.agent, ordinary)).toBe(ordinary);
    expect(f.cache.take(f.agent, [f.native])).toEqual([f.question]);
    expect(() => f.cache.take(f.agent, [f.native])).toThrow(
      'activation_question_invalid',
    );
  });

  it.each([
    'header',
    'question',
    'options-order',
    'option-description',
    'multiSelect',
    'detail',
    'receipt',
    'second-question',
  ])('rejects a changed %s before presentation', (field) => {
    const f = fixture();
    f.prepare();
    const q = structuredClone(f.question);
    if (field === 'header') q.header = 'Another company';
    if (field === 'question') q.question = 'Another candidate';
    if (field === 'options-order') q.options.reverse();
    if (field === 'option-description')
      q.options = q.options.map((o, i) =>
        i === 0 ? { ...o, description: 'Altered' } : o,
      );
    if (field === 'multiSelect') q.multiSelect = true;
    if (field === 'detail') q.detail = 'Omit all departments';
    if (field === 'receipt')
      q.id = methodActivationQuestionPrefix + randomUUID();
    expect(() =>
      f.cache.take(
        f.agent,
        field === 'second-question'
          ? [q, { id: 'extra', question: 'Extra?' }]
          : [q],
      ),
    ).toThrow('activation_question_invalid');
  });

  it('requires the same live agent and unexpired server receipt', () => {
    vi.useFakeTimers();
    const f = fixture();
    f.prepare();
    expect(() => f.cache.take({}, [f.native])).toThrow(
      'activation_question_invalid',
    );
    vi.advanceTimersByTime(60_001);
    expect(() => f.cache.take(f.agent, [f.native])).toThrow(
      'activation_question_invalid',
    );
    expect(() => preparedMethodQuestions().take(f.agent, [f.native])).toThrow(
      'activation_question_invalid',
    );
  });

  it('invalidates an earlier receipt on a new prepare, including failed and late responses', () => {
    const f = fixture();
    f.prepare();
    const old = f.cache.begin(f.agent);
    const current = f.cache.begin(f.agent);
    f.cache.complete(f.agent, old, f.response());
    f.cache.complete(f.agent, current, {
      modelContent: JSON.stringify({ error: 'denied' }),
    });
    expect(() => f.cache.take(f.agent, [f.native])).toThrow(
      'activation_question_invalid',
    );
    const late = f.cache.begin(f.agent);
    f.cache.clear(f.agent); // interruption / close / replacement
    f.cache.complete(f.agent, late, f.response());
    expect(() => f.cache.take(f.agent, [f.native])).toThrow(
      'activation_question_invalid',
    );
  });

  it.each(['enabled', 'receipt', 'oversized', 'expired', 'invalid-json'])(
    'cannot cache an invalid server result (%s)',
    (kind) => {
      const f = fixture();
      if (kind === 'enabled') f.result.enabled = true;
      if (kind === 'receipt') f.result.receiptId = randomUUID();
      if (kind === 'oversized') f.result.question.detail = 'x'.repeat(20_001);
      if (kind === 'expired') f.result.expiresAt = new Date(0).toISOString();
      f.cache.complete(
        f.agent,
        f.cache.begin(f.agent),
        kind === 'invalid-json' ? { modelContent: '{' } : f.response(),
      );
      expect(() => f.cache.take(f.agent, [f.native])).toThrow(
        'activation_question_invalid',
      );
    },
  );
});
