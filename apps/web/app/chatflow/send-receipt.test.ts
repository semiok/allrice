import { describe, expect, it } from 'vitest';
import { isSendReceipt } from './send-receipt';

const message = (
  role: 'user' | 'assistant',
  content: unknown = { text: '' },
) => ({
  id: `${role}-1`,
  role,
  content,
  status: role === 'user' ? 'completed' : 'pending',
  runId: null,
  createdAt: '2026-10-26T09:00:00.000Z',
});
const receipt = (overrides: Record<string, unknown> = {}) => ({
  run: { id: 'run-1' },
  fallbackRunId: null,
  delivery: 'follow_up',
  userMessage: message('user', { text: '整理周报', referenceSelections: [] }),
  assistantMessage: message('assistant'),
  ...overrides,
});

describe('a send receipt frees the retry key only when it is usable', () => {
  it('accepts the receipt the server sends', () => {
    expect(isSendReceipt(receipt())).toBe(true);
    expect(isSendReceipt(receipt({ delivery: 'immediate' }))).toBe(true);
  });

  it.each([
    ['no body', null],
    ['an empty object', {}],
    ['an unknown delivery', receipt({ delivery: 'later' })],
    ['a run without an ID', receipt({ run: {} })],
    [
      'a user message without content',
      receipt({ userMessage: message('user', null) }),
    ],
    [
      'a user message without text',
      receipt({ userMessage: message('user', { referenceSelections: [] }) }),
    ],
    [
      'reference selections that are not a list',
      receipt({
        userMessage: message('user', { text: '', referenceSelections: 'x' }),
      }),
    ],
    [
      'company assets that are not a record',
      receipt({ userMessage: message('user', { text: '', companyAssets: 3 }) }),
    ],
    [
      'an assistant message with an unknown status',
      receipt({
        assistantMessage: { ...message('assistant'), status: 'done' },
      }),
    ],
    ['swapped messages', receipt({ userMessage: message('assistant') })],
    [
      'a message without a time',
      receipt({ userMessage: { ...message('user'), createdAt: undefined } }),
    ],
  ])('rejects %s', (_, value) => {
    expect(isSendReceipt(value)).toBe(false);
  });
});
