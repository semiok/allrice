import { describe, expect, it } from 'vitest';
import { documentDeliveryGuard } from '../../src/jobs/document-delivery.js';
import type { HarnessToolCall } from '../../src/harness/adapter.js';
import { id, run, receipt, checksum } from './fixtures.js';
import { confirmToolFailure, HandlerError } from '../../src/errors.js';
const call = (n: number): HarnessToolCall => ({
  id: `call-${n}`,
  name: 'workspace.export.create',
  arguments: { format: 'xlsx', fileName: 'same.xlsx' },
});

const officeCall = (n: number, parentObjectId?: string): HarnessToolCall => ({
  ...call(n),
  arguments: {
    ...call(n).arguments,
    ...(parentObjectId ? { parentObjectId } : {}),
  },
});
const officeOutput = (
  n: number,
  kind: Parameters<typeof receipt>[0] = 'good',
  series = id(30),
  version = n,
) => ({
  modelContent: JSON.stringify({
    ...JSON.parse(output(n, kind, series).modelContent),
    artifactKind: 'document',
    version,
  }),
});
const parentFailure = (
  failed: HarnessToolCall,
  identity: { runId?: string; callId?: string; toolName?: string } | false = {},
) => {
  const error = new HandlerError(
    'TOOL_PUBLICATION_PARENT_INVALID',
    'Read the current parent and publish a new version',
    false,
  );
  if (identity !== false)
    confirmToolFailure(error, {
      runId: run,
      callId: failed.id,
      toolName: failed.name,
      ...identity,
    });
  return error;
};
const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
async function knownOfficeSeries(
  second: Parameters<typeof receipt>[0] = 'good',
  bindRun = true,
) {
  const guard = documentDeliveryGuard(
    'xlsx_formula_cache_v1',
    bindRun ? run : undefined,
  );
  const bad = officeOutput(1, 'missing');
  await guard.execute(officeCall(1), async () => bad);
  await guard.execute(officeCall(2, id(11)), async () =>
    officeOutput(2, second),
  );
  return { guard, bad };
}

describe('checked Office repair after a confirmed stale-parent failure', () => {
  it('completes the four-step same-Run repair using the real newer series receipt', async () => {
    const { guard, bad } = await knownOfficeSeries('missing');
    const before = bad.modelContent;
    const failed = officeCall(3, id(11)),
      error = parentFailure(failed);
    await expect(
      guard.execute(failed, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(() => guard.assertComplete()).toThrow('未收到成功交付回执');
    await guard.execute(officeCall(4, id(12)), async () => officeOutput(3));
    expect(() => guard.assertComplete()).not.toThrow();
    expect(bad.modelContent).toBe(before);
    expect(
      JSON.parse(bad.modelContent).savedValues.counts.missingCacheCount,
    ).toBe(1);
  });
  it.each([
    'unconfirmed',
    'foreign-run',
    'foreign-call',
    'foreign-tool',
    'unbound-run',
    'unknown-write',
  ])(
    'keeps the original failure pending without exact private confirmation: %s',
    async (kind) => {
      const { guard } = await knownOfficeSeries('good', kind !== 'unbound-run');
      const failed = officeCall(3, id(11));
      const error =
        kind === 'unknown-write'
          ? Error('write acknowledgement lost')
          : parentFailure(
              failed,
              kind === 'unconfirmed'
                ? false
                : kind === 'foreign-run'
                  ? { runId: id(99) }
                  : kind === 'foreign-call'
                    ? { callId: 'foreign' }
                    : kind === 'foreign-tool'
                      ? { toolName: 'workspace.document.read' }
                      : {},
            );
      await expect(
        guard.execute(failed, async () => {
          throw error;
        }),
      ).rejects.toBe(error);
      await guard.execute(officeCall(4, id(12)), async () => officeOutput(3));
      expect(() => guard.assertComplete()).toThrow('未收到成功交付回执');
    },
  );
  it('does not infer an unknown failed parent from the model request or a later good series head', async () => {
    const { guard } = await knownOfficeSeries();
    const failed = officeCall(3, id(98)),
      error = parentFailure(failed);
    await expect(
      guard.execute(failed, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    await guard.execute(officeCall(4, id(12)), async () => officeOutput(3));
    expect(() => guard.assertComplete()).toThrow('未收到成功交付回执');
  });
  it.each(['other-series', 'other-format', 'constant-head', 'old-replay'])(
    'does not reconcile a confirmed old-parent failure with %s',
    async (kind) => {
      const { guard } = await knownOfficeSeries();
      const failed = officeCall(3, id(11)),
        error = parentFailure(failed);
      await expect(
        guard.execute(failed, async () => {
          throw error;
        }),
      ).rejects.toBe(error);
      const correcting = officeCall(4, id(12));
      if (kind === 'other-format') correcting.arguments.format = 'docx';
      await guard.execute(correcting, async () =>
        kind === 'other-series'
          ? officeOutput(100, 'good', id(31), 1)
          : kind === 'constant-head'
            ? officeOutput(3, 'zero')
            : kind === 'old-replay'
              ? officeOutput(2)
              : officeOutput(3),
      );
      expect(() => guard.assertComplete()).toThrow('未收到成功交付回执');
    },
  );
  it('cannot reconcile using receipt prose, a changed byte checksum, or conflicting object identity', async () => {
    for (const kind of ['prose', 'checksum', 'object-conflict']) {
      const { guard } = await knownOfficeSeries();
      const failed = officeCall(3, id(11)),
        error = parentFailure(failed);
      await expect(
        guard.execute(failed, async () => {
          throw error;
        }),
      ).rejects.toBe(error);
      const result = officeOutput(3);
      const row = JSON.parse(result.modelContent);
      if (kind === 'prose') delete row.savedValues;
      if (kind === 'checksum') row.digest = 'sha256:' + 'b'.repeat(64);
      if (kind === 'object-conflict') row.objectId = id(11);
      await guard.execute(officeCall(4, id(12)), async () => ({
        modelContent: JSON.stringify(row),
      }));
      expect(() => guard.assertComplete()).toThrow();
    }
  });
  it('does not let an older invocation finishing late hide a newer failed correction', async () => {
    const { guard } = await knownOfficeSeries();
    const wait = defer();
    const old = guard.execute(officeCall(3, id(12)), async () => {
      await wait.promise;
      return officeOutput(3);
    });
    const failed = officeCall(4, id(11)),
      error = parentFailure(failed);
    await expect(
      guard.execute(failed, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    wait.resolve();
    await old;
    expect(() => guard.assertComplete()).toThrow('未收到成功交付回执');
    await guard.execute(officeCall(5, id(13)), async () => officeOutput(4));
    expect(() => guard.assertComplete()).not.toThrow();
  });
  it.each(['failure-first', 'success-first'])(
    'does not treat already overlapping work as an observed-failure correction: %s',
    async (ordering) => {
      const { guard } = await knownOfficeSeries();
      const failWait = defer(),
        successWait = defer();
      const failed = officeCall(3, id(11)),
        error = parentFailure(failed);
      const failing = expect(
        guard.execute(failed, async () => {
          await failWait.promise;
          throw error;
        }),
      ).rejects.toBe(error);
      const completing = guard.execute(officeCall(4, id(12)), async () => {
        await successWait.promise;
        return officeOutput(3);
      });
      if (ordering === 'failure-first') {
        failWait.resolve();
        await failing;
        successWait.resolve();
        await completing;
      } else {
        successWait.resolve();
        await completing;
        failWait.resolve();
        await failing;
      }
      expect(() => guard.assertComplete()).toThrow('未收到成功交付回执');
      await guard.execute(officeCall(5, id(13)), async () => officeOutput(4));
      expect(() => guard.assertComplete()).not.toThrow();
    },
  );
  it('retains at most 1000 trusted object identities and fails closed instead of evicting earlier parents', async () => {
    const guard = documentDeliveryGuard('xlsx_formula_cache_v1', run);
    for (let n = 1; n <= 1000; n++)
      await guard.execute(officeCall(n), async () => officeOutput(n));
    expect(() => guard.assertComplete()).not.toThrow();
    await guard.execute(officeCall(1001), async () => officeOutput(1001));
    expect(() => guard.assertComplete()).toThrow('真实文件回执未确认');
  });
});
const output = (
  n: number,
  kind: Parameters<typeof receipt>[0],
  series = id(30),
) => ({
  modelContent: JSON.stringify({
    ...receipt(kind),
    artifactId: id(20 + n),
    objectId: id(10 + n),
    digest: checksum,
    seriesId: series,
    version: n,
    fileName: 'same.xlsx',
    mediaType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    officeCache: { status: 'satisfied' },
  }),
});
describe('actual document guard consumes receipt facts, never status prose', () => {
  it('keeps legacy opt-out unchanged and does not trust forged officeCache success', async () => {
    const old = documentDeliveryGuard();
    await old.execute(call(1), async () => output(1, 'missing'));
    expect(() => old.assertComplete()).not.toThrow();
    const checked = documentDeliveryGuard('xlsx_formula_cache_v1');
    await checked.execute(call(1), async () => output(1, 'missing'));
    expect(() => checked.assertComplete()).toThrow('公式缓存检查未完成');
  });
  it('only a real same-series newer receipt repairs a partial file', async () => {
    const checked = documentDeliveryGuard('xlsx_formula_cache_v1');
    await checked.execute(call(1), async () => output(1, 'missing'));
    await checked.execute(call(2), async () => output(2, 'good', id(31)));
    expect(() => checked.assertComplete()).toThrow();
    await checked.execute(call(3), async () => output(3, 'good'));
    expect(() => checked.assertComplete()).not.toThrow();
  });
  it('keeps a formula obligation through constants and handles late old replies without downgrading a repaired head', async () => {
    const checked = documentDeliveryGuard('xlsx_formula_cache_v1');
    await checked.execute(call(1), async () => output(1, 'missing'));
    await checked.execute(call(2), async () => output(2, 'zero'));
    expect(() => checked.assertComplete()).toThrow();
    await checked.execute(call(3), async () => output(3, 'good'));
    await checked.execute(call(1), async () => output(1, 'missing'));
    expect(() => checked.assertComplete()).not.toThrow();
  });
  it('binds cache facts to the returned real object checksum and refuses unbound replies', async () => {
    for (const result of [
      {
        modelContent: JSON.stringify({ officeCache: { status: 'satisfied' } }),
      },
      {
        modelContent: JSON.stringify({
          ...JSON.parse(output(1, 'good').modelContent),
          digest: 'sha256:' + 'b'.repeat(64),
        }),
      },
    ]) {
      const checked = documentDeliveryGuard('xlsx_formula_cache_v1');
      await checked.execute(call(1), async () => result);
      expect(() => checked.assertComplete()).toThrow();
    }
  });
});
