import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  attachExecutionFailureUsage,
  getExecutionFailureUsage,
} from './execution-failure-usage.js';
const result = {
  usage: { inputTokens: 20, cachedInputTokens: 0, outputTokens: 5 },
};
it('failure receipts are local, bound to the exact Run/attempt and cannot be forged by serialized fields', () => {
  const error = Object.freeze(Error('original failure'));
  const runId = randomUUID();
  const receipt = {
    usage: { ...result.usage },
    usageComplete: true,
    cacheUsageKnown: false,
  };
  attachExecutionFailureUsage(error, runId, 1, receipt);
  expect(getExecutionFailureUsage(error, runId, 1)).toEqual(receipt);
  expect(getExecutionFailureUsage(error, randomUUID(), 1)).toBeUndefined();
  expect(getExecutionFailureUsage(error, runId, 2)).toBeUndefined();
  expect(
    getExecutionFailureUsage({ ...receipt, runId, attempt: 1 }, runId, 1),
  ).toBeUndefined();
  expect(
    getExecutionFailureUsage(JSON.parse(JSON.stringify(error)), runId, 1),
  ).toBeUndefined();
  receipt.usage.inputTokens = 999;
  expect(getExecutionFailureUsage(error, runId, 1)?.usage.inputTokens).toBe(20);
});
