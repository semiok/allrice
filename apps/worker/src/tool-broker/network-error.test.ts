import { expect, it } from 'vitest';
import { RuntimePolicyError } from '@allrice/database';
import { confirmToolFailure, isConfirmedToolFailure } from '../errors.js';
import { sandboxNetworkError } from './network-error.js';
const identity = { runId: 'run', callId: 'call', toolName: 'python.execute' };
it.each([
  'sandbox_network_destination_blocked',
  'sandbox_network_check_unavailable',
])('explains %s without inventing a stopped execution receipt', (code) => {
  const cause = new RuntimePolicyError(code);
  const unknown = sandboxNetworkError(cause, identity);
  expect(unknown).toMatchObject({ code: code.toUpperCase(), retryable: false });
  expect(isConfirmedToolFailure(unknown, identity)).toBe(false);
  confirmToolFailure(cause, identity);
  const stopped = sandboxNetworkError(cause, identity);
  expect(isConfirmedToolFailure(stopped, identity)).toBe(true);
  expect(
    isConfirmedToolFailure(stopped, { ...identity, callId: 'other' }),
  ).toBe(false);
});
it('leaves other error classifications and uncertain transport failures unchanged', () => {
  for (const error of [
    new Error('unknown'),
    new RuntimePolicyError('membership_denied'),
  ])
    expect(sandboxNetworkError(error, identity)).toBe(error);
});
