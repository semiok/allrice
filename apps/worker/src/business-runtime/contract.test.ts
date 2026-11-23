import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readBusinessProjection } from './contract.ts';

describe('host business projection boundary', () => {
  it('rejects a missing source rather than manufacture an authority or successful fact', async () => {
    await expect(
      readBusinessProjection('contract-fake.required', undefined, z.boolean()),
    ).rejects.toMatchObject({
      code: 'business_runtime_dependency_unavailable',
    });
  });

  it('preserves a real source failure and does not coerce malformed data to success', async () => {
    const failure = new Error('contract-fake source permission query failed');
    await expect(
      readBusinessProjection(
        'contract-fake.source',
        async () => {
          throw failure;
        },
        z.boolean(),
      ),
    ).rejects.toBe(failure);
    await expect(
      readBusinessProjection(
        'contract-fake.source',
        async () => 'false',
        z.boolean(),
      ),
    ).rejects.toMatchObject({ code: 'business_runtime_projection_invalid' });
  });

  it('joins actual pending work after cancellation and suppresses its late projection', async () => {
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    const source = vi.fn(async () => {
      await gate;
      return false;
    });
    const pending = readBusinessProjection(
      'contract-fake.slow-source',
      source,
      z.boolean(),
      controller.signal,
    ).then(
      () => {
        finished = true;
        return null;
      },
      (error: unknown) => {
        finished = true;
        return error;
      },
    );
    controller.abort();
    await Promise.resolve();
    expect(source).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    release();
    expect(await pending).toMatchObject({ name: 'AbortError' });
  });

  it('stops before admitting new source I/O when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const read = vi.fn(async () => true);
    await expect(
      readBusinessProjection(
        'contract-fake.source',
        read,
        z.boolean(),
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled();
  });
});
