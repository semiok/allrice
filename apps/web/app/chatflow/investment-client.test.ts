import { randomUUID } from 'node:crypto';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { saveInvestment } from './investment-client';
import type {
  InvestmentBaseline,
  InvestmentRevision,
} from '@allrice/contracts';
const content: InvestmentBaseline = {
  kind: 'baseline',
  key: 'a',
  title: 'a',
  taskType: '运营',
  unit: '份',
  minutesPerUnit: 60,
  hourlyRateMinor: null,
  currency: null,
  source: '人工计时',
};
function revision(entryId: string): InvestmentRevision {
  return {
    id: randomUUID(),
    entryId,
    number: 1,
    organizationId: randomUUID(),
    workspaceId: null,
    ownerId: randomUUID(),
    content,
    facts: {},
    digest: `sha256:${'0'.repeat(64)}`,
    createdAt: new Date().toISOString(),
    createdBy: randomUUID(),
  };
}
afterEach(() => vi.unstubAllGlobals());
describe('investment ambiguous write reconciliation', () => {
  it('reads the stable id and recovers a committed save without repeating the POST', async () => {
    const id = randomUUID(),
      r = revision(id),
      fetch = vi
        .fn()
        .mockRejectedValueOnce(Error('connection lost'))
        .mockResolvedValueOnce(
          Response.json({ entries: [r], nextCursor: null }),
        );
    vi.stubGlobal('fetch', fetch);
    expect(
      await saveInvestment('/api/v1/investment', {}, id, 0, content),
    ).toEqual(r);
    expect(fetch.mock.calls).toHaveLength(2);
    expect(fetch.mock.calls[0]![1].method).toBe('POST');
    expect(fetch.mock.calls[1]![1].method).toBeUndefined();
    expect(fetch.mock.calls[1]![0]).toContain('entryId=' + id);
  });
  it('never accepts a different concurrent revision or retries an unresolved write', async () => {
    const id = randomUUID(),
      r = revision(id);
    r.content = { ...content, minutesPerUnit: 120 };
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(Error('connection lost'))
      .mockResolvedValueOnce(Response.json({ entries: [r], nextCursor: null }));
    vi.stubGlobal('fetch', fetch);
    await expect(
      saveInvestment('/api/v1/investment', {}, id, 0, content),
    ).rejects.toThrow('connection lost');
    expect(fetch.mock.calls).toHaveLength(2);
  });
});
