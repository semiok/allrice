import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createBoundedDeliveryRepair } from './repair.js';

type RepairInput = Parameters<typeof createBoundedDeliveryRepair>[0];
type Budgets = Awaited<ReturnType<RepairInput['budgets']>>;
const sha = (text: string) =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;
const request = {
  phase: 'propose',
  candidate: {
    nativeSessionId: 'budget-fixture',
    turn: 1,
    publicMessageId: 'empty-parent-reply',
    durableSeq: 20,
    text: '',
    candidateDigest: sha(''),
    provider: 'openai-codex',
    model: 'synthetic-never-called',
  },
};
const budgets = (enforced?: boolean) => [
  { metric: 'model_calls', capacity: 10, reserved: 2, spent: 3, enforced },
  { metric: 'output_tokens', capacity: 100, reserved: 40, spent: 80, enforced },
];
function fixture(values: unknown) {
  const assertAuthority = vi.fn(async () => {});
  const close = vi.fn();
  const port = createBoundedDeliveryRepair({
    nativeSessionId: request.candidate.nativeSessionId,
    scope: {
      organizationId: 'org',
      workspaceId: 'workspace',
      ownerId: 'owner',
      sessionId: 'session',
      runId: 'root',
    },
    generation: 1,
    attempt: 1,
    leaseToken: 'fixture-lease',
    deadlineAt: Date.now() + 60_000,
    provider: request.candidate.provider,
    model: request.candidate.model,
    assertAuthority,
    read: vi.fn(),
    budgets: async () => values as Budgets,
    close,
  });
  return { port, assertAuthority, close };
}

describe('MET-219 repair budget boundary', () => {
  it.each([
    { enforced: undefined, calls: 5, output: 0 },
    { enforced: true, calls: 5, output: 0 },
    { enforced: false, calls: 10, output: 100 },
  ])(
    'preserves the contract for enforced=$enforced in every phase',
    async ({ enforced, calls, output }) => {
      const values = budgets(enforced);
      if (enforced === undefined)
        for (const value of values) delete value.enforced;
      const before = structuredClone(values);
      const f = fixture(values);
      for (const phase of ['propose', 'prepared', 'consume', 'dispatch']) {
        await expect(
          f.port.authorize({ ...request, phase }),
        ).resolves.toMatchObject({
          allowed: true,
          remainingModelCalls: calls,
          remainingOutputTokens: output,
        });
        expect(values).toEqual(before);
      }
      expect(f.close).not.toHaveBeenCalled();
    },
  );

  it('applies enforcement separately to each metric and keeps a zero capacity at zero', async () => {
    const values = budgets(false);
    values[0]!.enforced = true;
    values[1]!.capacity = 0;
    await expect(
      fixture(values).port.authorize(request),
    ).resolves.toMatchObject({
      remainingModelCalls: 5,
      remainingOutputTokens: 0,
    });
  });

  it.each([
    ['missing metric', (b: ReturnType<typeof budgets>): unknown => b.pop()],
    [
      'duplicate metric',
      (b: ReturnType<typeof budgets>): unknown => b.push({ ...b[1]! }),
    ],
    [
      'negative capacity',
      (b: ReturnType<typeof budgets>): unknown => (b[0]!.capacity = -1),
    ],
    [
      'fractional reservation',
      (b: ReturnType<typeof budgets>): unknown => (b[1]!.reserved = 0.5),
    ],
    [
      'NaN spend',
      (b: ReturnType<typeof budgets>): unknown => (b[1]!.spent = NaN),
    ],
    [
      'infinite capacity',
      (b: ReturnType<typeof budgets>): unknown => (b[1]!.capacity = Infinity),
    ],
    [
      'unsafe spend',
      (b: ReturnType<typeof budgets>): unknown =>
        (b[0]!.spent = Number.MAX_SAFE_INTEGER + 1),
    ],
  ] as const)(
    'rejects %s even for an observed budget',
    async (_label, corrupt) => {
      const values = budgets(false);
      corrupt(values);
      await expect(fixture(values).port.authorize(request)).rejects.toThrow(
        'FINAL_DELIVERY_REPAIR_BUDGET_UNAVAILABLE',
      );
    },
  );

  it.each([
    ['capacity', undefined],
    ['reserved', '100'],
    ['spent', null],
  ] as const)(
    'rejects malformed %s=%s before ignoring observed totals',
    async (field, value) => {
      const values = budgets(false);
      Object.assign(values[1]!, { [field]: value });
      if (value === undefined) Reflect.deleteProperty(values[1]!, field);
      await expect(fixture(values).port.authorize(request)).rejects.toThrow(
        'FINAL_DELIVERY_REPAIR_BUDGET_UNAVAILABLE',
      );
    },
  );

  it('rechecks authority after reading an observed budget', async () => {
    const f = fixture(budgets(false));
    f.assertAuthority
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Error('lease_lost'));
    await expect(f.port.authorize(request)).rejects.toThrow('lease_lost');
    expect(f.assertAuthority).toHaveBeenCalledTimes(2);
    expect(f.close).not.toHaveBeenCalled();
  });
});
