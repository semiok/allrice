import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createBoundedDeliveryRepair } from './repair.js';
import type { DeliverySnapshot } from './policy.js';

const id = (n: number) =>
  '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const sha = (text: string) =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;
const scope = {
  organizationId: id(1),
  workspaceId: id(2),
  ownerId: id(3),
  sessionId: id(4),
  runId: id(5),
};
const file = {
  objectId: id(10),
  versionId: id(11),
  checksum: sha('retained original bytes'),
};
const candidate = (text: string) => ({
  nativeSessionId: 'native-fixture',
  turn: 1,
  publicMessageId: 'original-model-message',
  durableSeq: 20,
  text,
  candidateDigest: sha(text),
  provider: 'openai-codex',
  model: 'gpt-6.1-sol',
});
const invalid = candidate(
  '数据核验完成。[下载](／api) no incorrect need actual.',
);
const valid = candidate(`[下载](/api/v1/files/${file.objectId}/download)`);
function fixture() {
  const snapshot: DeliverySnapshot = {
    scope,
    complete: true,
    authorization: 'current',
    now: new Date().toISOString(),
    ownedRunIds: [scope.runId],
    explicitReferenceVersionIds: [],
    artifacts: [
      {
        ...file,
        scope,
        originRunId: scope.runId,
        fileName: '经营复盘.docx',
        state: 'ready',
        immutable: true,
        deletedAt: null,
        retentionUntil: null,
      },
    ],
    checks: [],
    requirements: [],
  };
  const assertAuthority = vi.fn(async () => {});
  const close = vi.fn(async (callId: string) => ({
    closed: true as const,
    callId,
    alreadyClosed: false,
  }));
  const budgets = [
    { metric: 'model_calls', capacity: 10, reserved: 0, spent: 2 },
    { metric: 'output_tokens', capacity: 10000, reserved: 100, spent: 2000 },
  ];
  const input = {
    nativeSessionId: 'native-fixture',
    scope,
    generation: 2,
    attempt: 1,
    leaseToken: 'private-lease-not-a-native-argument',
    deadlineAt: Date.now() + 60_000,
    provider: 'openai-codex',
    model: 'gpt-6.1-sol',
    assertAuthority,
    read: async () => snapshot,
    budgets: async () => budgets,
    close,
  };
  return {
    input,
    port: createBoundedDeliveryRepair(input),
    snapshot,
    assertAuthority,
    close,
    budgets,
  };
}

describe('private final delivery repair proposal', () => {
  it('does not certify a reply that asks the outer adapter to execute another tool', async () => {
    const f = fixture();
    const envelope =
      '<allrice_tool_call>{"id":"not-a-delivery","name":"workspace.export.create","arguments":{}}</allrice_tool_call>';
    expect(await f.port.inspect(candidate(envelope))).toMatchObject({
      decision: 'blocked',
      issues: ['business_tool_envelope'],
      references: [],
    });
  });
  it('binds the original invalid slash link to already-authorized versions without rewriting it', async () => {
    const f = fixture();
    const before = JSON.stringify(f.snapshot);
    expect(await f.port.inspect(invalid)).toMatchObject({
      decision: 'repair',
      candidateDigest: invalid.candidateDigest,
      issues: ['invalid_delivery_link'],
      references: [
        {
          ...file,
          displayName: '经营复盘.docx',
          downloadUrl: `/api/v1/files/${file.objectId}/download`,
        },
      ],
    });
    expect(JSON.stringify(f.snapshot)).toBe(before);
    expect(invalid.text).toContain('／api');
    expect(f.close).not.toHaveBeenCalled();
  });
  it('requires no repair for a valid reply, and does not pretend to judge business conclusions', async () => {
    const f = fixture();
    expect(await f.port.inspect(valid)).toMatchObject({
      decision: 'pass',
      references: [],
    });
    expect(await f.port.inspect(candidate('未核实的业务结论'))).toMatchObject({
      decision: 'pass',
    });
  });
  it('cannot repair missing cache or missing artifacts by changing the reply', async () => {
    const f = fixture();
    f.snapshot.requirements = [
      {
        id: 'formulas',
        expected: file,
        source: 'current_run',
        requireLink: true,
        requiredChecks: ['office.saved_values'],
      },
    ];
    f.snapshot.checks = [
      {
        ...file,
        scope,
        originRunId: scope.runId,
        checkId: 'office.saved_values',
        status: 'failed',
      },
    ];
    expect(await f.port.inspect(invalid)).toMatchObject({
      decision: 'blocked',
      references: [],
    });
    f.snapshot.artifacts = [];
    expect(await f.port.inspect(invalid)).toMatchObject({
      decision: 'blocked',
    });
  });
  it.each(['complete', 'owner', 'deleted', 'expiry'])(
    'fails closed on %s evidence',
    async (reason) => {
      const f = fixture();
      if (reason === 'complete') f.snapshot.complete = false;
      if (reason === 'owner')
        f.snapshot.artifacts[0]!.scope = { ...scope, ownerId: id(99) };
      if (reason === 'deleted')
        f.snapshot.artifacts[0]!.deletedAt = new Date().toISOString();
      if (reason === 'expiry')
        f.snapshot.artifacts[0]!.retentionUntil = '2000-01-01T00:00:00Z';
      expect(await f.port.inspect(invalid)).toMatchObject({
        decision: 'blocked',
      });
    },
  );
  it('rejects another native identity, changed candidate bytes and extra forged fields', async () => {
    const f = fixture();
    for (const raw of [
      { ...invalid, nativeSessionId: 'foreign' },
      { ...invalid, text: 'changed' },
      { ...invalid, allowed: true },
    ])
      await expect(f.port.inspect(raw)).rejects.toThrow();
    expect(f.assertAuthority).not.toHaveBeenCalled();
  });
  it('rechecks revoked authority after reading facts', async () => {
    const f = fixture();
    f.assertAuthority
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Error('lease_lost'));
    await expect(f.port.inspect(invalid)).rejects.toThrow('lease_lost');
  });
  it('uses server-bound authority and the original deadline/budget without increasing either', async () => {
    const f = fixture();
    const result = await f.port.authorize({
      candidate: invalid,
      phase: 'propose',
    });
    expect(result).toMatchObject({
      allowed: true,
      runId: scope.runId,
      generation: 2,
      attempt: 1,
      workerLeaseDigest: sha(f.input.leaseToken),
      originalDeadlineAt: f.input.deadlineAt,
      remainingModelCalls: 8,
      remainingOutputTokens: 7900,
    });
    expect(JSON.stringify(result)).not.toContain(f.input.leaseToken);
    for (const raw of [
      { candidate: { ...invalid, model: 'other' }, phase: 'dispatch' },
      { candidate: invalid, phase: 'propose', remainingModelCalls: 999 },
    ])
      await expect(f.port.authorize(raw)).rejects.toThrow();
    expect(f.budgets[0]!.capacity).toBe(10);
  });
  it('an observed budget bounds the repair call by capacity, not by spend or unknown reservations', async () => {
    const f = fixture();
    // A stopped child's aborted call keeps its full reservation, and the
    // tree has already spent past one response's output bound.
    Object.assign(f.budgets[0]!, { spent: 12, reserved: 1, enforced: false });
    Object.assign(f.budgets[1]!, {
      spent: 9000,
      reserved: 10000,
      enforced: false,
    });
    expect(
      await f.port.authorize({ candidate: invalid, phase: 'propose' }),
    ).toMatchObject({ remainingModelCalls: 10, remainingOutputTokens: 10000 });
    expect(f.budgets[1]).toMatchObject({ spent: 9000, reserved: 10000 });
    // An enforced budget still counts every spent and reserved unit.
    delete (f.budgets[1] as { enforced?: boolean }).enforced;
    expect(
      await f.port.authorize({ candidate: invalid, phase: 'propose' }),
    ).toMatchObject({ remainingModelCalls: 10, remainingOutputTokens: 0 });
  });
  it('does not infer unused preparation closure from missing usage or a native assertion', async () => {
    const f = fixture();
    f.close.mockRejectedValueOnce(Error('model_already_dispatched'));
    await expect(
      f.port.closePreparation({
        nativeSessionId: 'native-fixture',
        callId: id(20),
      }),
    ).rejects.toThrow('model_already_dispatched');
    expect(f.close).toHaveBeenCalledExactlyOnceWith(id(20));
    await expect(
      f.port.closePreparation({ nativeSessionId: 'foreign', callId: id(20) }),
    ).rejects.toThrow('IDENTITY');
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('refuses an expired original deadline', async () => {
    const f = fixture();
    const port = createBoundedDeliveryRepair({
      ...f.input,
      deadlineAt: Date.now() - 1,
    });
    await expect(
      port.authorize({ candidate: invalid, phase: 'propose' }),
    ).rejects.toThrow('DEADLINE');
  });
});
