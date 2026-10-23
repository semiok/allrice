import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DshRuntimeProcessSnapshot } from './dsh-runtime-registry.ts';
const fixture = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  readDshRuntimeCloseCoverage: vi.fn(),
}));
vi.mock('./dsh-runtime-close-observations.ts', () => fixture);
vi.mock('../core/client.ts', () => fixture);
import { finalizeWorkerDshRuntimeInventory } from './dsh-runtime-registry.ts';
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity = {
  workerId: id(1),
  workerBootId: id(99),
  serviceManifestDigest: `sha256:${'e'.repeat(64)}`,
};
const live = (): DshRuntimeProcessSnapshot => ({
  id: id(3),
  organizationId: id(4),
  workspaceId: id(5),
  sessionId: id(6),
  ownerId: id(7),
  threadId: 'native',
  providerRoute: 'openai-codex',
  model: 'test',
  reasoningEffort: 'low',
  profileFingerprint: 'a'.repeat(64),
  nativeTools: [],
  startedAt: '2026-10-23T00:00:00.000Z',
  lastActivityAt: '2026-10-23T00:00:00.000Z',
});
let statements: { text: string; values: unknown[] }[];
let transaction: ReturnType<typeof vi.fn> & {
  array(value: unknown): unknown;
  json(value: unknown): unknown;
};
beforeEach(() => {
  vi.resetAllMocks();
  statements = [];
  fixture.readDshRuntimeCloseCoverage.mockResolvedValue(
    [2, 3].map((n) => ({
      owner: {
        ...identity,
        runtimeId: id(n),
        context: {
          kind: 'context',
          contextKind: 'chat',
          organizationId: id(4),
          workspaceId: id(5),
          contextId: id(6),
          ownerId: id(7),
        },
      },
      physical: n === 2 ? 'exited' : 'unknown',
    })),
  );
  transaction = Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push({
        text: strings.join('?').replace(/\s+/g, ' ').trim(),
        values,
      });
      return strings.join(' ').trim().startsWith('insert')
        ? [{ id: values[0] }]
        : [];
    }),
    { array: (x: unknown) => x, json: (x: unknown) => x },
  );
  fixture.getDatabase.mockReturnValue({
    begin: async (body: (tx: typeof transaction) => Promise<unknown>) =>
      body(transaction),
  });
});
describe('final physical registry write is narrow, not close evidence', () => {
  it('targets exact exited IDs and worker, never TTL/blanket offlining', async () => {
    await finalizeWorkerDshRuntimeInventory({
      ...identity,
      runtimes: [],
      exitedRuntimeIds: [id(2)],
    });
    const updates = statements.filter((s) => s.text.startsWith('update '));
    expect(updates).toHaveLength(1);
    expect(updates[0]?.text).toContain(
      'where worker_id = ? and id = any(?::uuid[])',
    );
    expect(updates[0]?.values).toEqual([id(1), [id(2)]]);
    expect(
      statements.some((s) => /last_seen_at <|id <> all/.test(s.text)),
    ).toBe(false);
  });
  it('keeps owned active instances live through the identity-preserving registry upsert', async () => {
    await finalizeWorkerDshRuntimeInventory({
      ...identity,
      runtimes: [live()],
      exitedRuntimeIds: [id(2)],
    });
    const insert = statements.find((s) => s.text.startsWith('insert '));
    expect(insert?.text).toContain("status = 'live'");
    expect(insert?.values.slice(0, 6)).toEqual([
      id(3),
      id(1),
      id(4),
      id(5),
      id(6),
      id(7),
    ]);
    expect(fixture.readDshRuntimeCloseCoverage).toHaveBeenCalledWith(
      transaction,
      { workerBootId: identity.workerBootId },
    );
    expect(insert?.text).toContain(
      'allrice_dsh_runtime_instances.id = excluded.id',
    );
  });
  it('an empty final view does not offline any unrelated old row', async () => {
    await finalizeWorkerDshRuntimeInventory({
      ...identity,
      runtimes: [],
      exitedRuntimeIds: [],
    });
    expect(
      statements.find((s) => s.text.startsWith('update '))?.values,
    ).toEqual([id(1), []]);
  });
  it.each(['overlap', 'duplicate_exit', 'duplicate_active'] as const)(
    'rejects %s before touching SQL',
    async (mode) => {
      const rows = mode === 'duplicate_active' ? [live(), live()] : [live()];
      const exits =
        mode === 'overlap'
          ? [id(3)]
          : mode === 'duplicate_exit'
            ? [id(2), id(2)]
            : [];
      await expect(
        finalizeWorkerDshRuntimeInventory({
          ...identity,
          runtimes: rows,
          exitedRuntimeIds: exits,
        }),
      ).rejects.toThrow('DSH_CLOSE_INVENTORY_CONFLICT');
      expect(fixture.getDatabase).not.toHaveBeenCalled();
    },
  );
  it('does not swallow a final registry transaction error', async () => {
    transaction.mockRejectedValueOnce(Error('database unavailable'));
    await expect(
      finalizeWorkerDshRuntimeInventory({
        ...identity,
        runtimes: [],
        exitedRuntimeIds: [],
      }),
    ).rejects.toThrow('database unavailable');
  });
  it('bounds the final database transaction while never forging evidence on timeout', async () => {
    await finalizeWorkerDshRuntimeInventory({
      ...identity,
      runtimes: [],
      exitedRuntimeIds: [],
    });
    expect(statements.slice(0, 2).map((s) => s.text)).toEqual([
      "set local statement_timeout='5000'",
      "set local lock_timeout='1000'",
    ]);
    expect(fixture.readDshRuntimeCloseCoverage).toHaveBeenCalledWith(
      transaction,
      { workerBootId: identity.workerBootId },
    );
    expect(
      statements.every(
        (s) =>
          !s.text.startsWith('delete ') &&
          !s.text.startsWith(
            'insert into allrice_dsh_runtime_close_observations',
          ),
      ),
    ).toBe(true);
  });
});
