import { describe, it, expect, vi } from 'vitest';
import { FixedRepositoryGithub } from './github.js';
import { mergeRepositoryCandidate } from './merger.js';
describe('product maintenance stops at a pull request', () => {
  it('refuses ready/merge directly at the remote transport before requesting credentials or HTTP', async () => {
    const gate = vi.fn(),
      transport = vi.fn();
    const github = new FixedRepositoryGithub(
      gate,
      new AbortController().signal,
      transport,
    );
    await expect(
      github.readyPull(10, 'allrice/repair', 'PR_node'),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      github.mergeExactPull(10, 'a'.repeat(40)),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(gate).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
  it('refuses a historical queued write even if the caller supplies a custom store and client', async () => {
    const read = vi
        .fn()
        .mockResolvedValue({ mode: 'merge', review: { material: {} } }),
      start = vi.fn(),
      finish = vi.fn(),
      transport = vi.fn();
    const github = new FixedRepositoryGithub(
      vi.fn(),
      new AbortController().signal,
      transport,
    );
    await expect(
      mergeRepositoryCandidate(
        {
          workerId: 'fixture',
          jobId: crypto.randomUUID(),
          leaseToken: crypto.randomUUID(),
          attempt: 1,
        },
        new AbortController().signal,
        { github, store: { read, start, finish } },
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(start).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
});
