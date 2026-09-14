import { describe, expect, it, vi } from 'vitest';
import {
  authorizeP27CodexWorker,
  onceP27CodexWorker,
  parseP27CodexWorkerArguments,
  P27_CODEX_COST_CAVEAT,
  P27_CODEX_LIMIT_CAVEAT,
  P27_CODEX_ORDINARY_LIMITS,
} from './p27-codex-worker-preflight.ts';

const sha = 'a'.repeat(40);
const authorized = () => ({
  ALLRICE_B6_P27_CODEX_WORKER_AUTHORIZED: '1',
  ALLRICE_B6_P27_CODEX_WORKER_AUTHORIZED_SHA: sha,
  ALLRICE_B6_P27_CODEX_WORKER_MAX_EXECUTIONS: '1',
  ALLRICE_B6_P27_CODEX_WORKER_SOFT_LIMIT_ACK: '1',
  ALLRICE_B6_P27_CODEX_WORKER_LEGACY_COST_ACK: '1',
});
describe('ordinary-only Codex Worker authorization', () => {
  it('requires explicit Codex selection, including in preflight', () => {
    for (const provider of [undefined, 'gemini'])
      expect(() =>
        parseP27CodexWorkerArguments([
          '--preflight',
          `--candidate-sha=${sha}`,
          ...(provider ? [`--provider=${provider}`] : []),
        ]),
      ).toThrow();
    expect(
      parseP27CodexWorkerArguments([
        '--preflight',
        `--candidate-sha=${sha}`,
        '--provider=openai-codex',
      ]).providerRoute,
    ).toBe('openai-codex');
  });
  it.each(Object.keys(authorized()))(
    'requires exact acknowledgement %s',
    (key) => {
      expect(() =>
        authorizeP27CodexWorker({ ...authorized(), [key]: 'different' }, sha),
      ).toThrow();
    },
  );
  it.each(['DATABASE_URL', 'ALLRICE_TEST_DATABASE_URL'])(
    'rejects ambient %s',
    (key) => {
      expect(() =>
        authorizeP27CodexWorker(
          { ...authorized(), [key]: 'postgres://live' },
          sha,
        ),
      ).toThrow();
    },
  );
  it('rejects old Gemini and assistant tickets', () => {
    expect(() =>
      authorizeP27CodexWorker(
        {
          ALLRICE_B6_P27_PROVIDER_AUTHORIZED: '1',
          ALLRICE_B6_P27_AUTHORIZED_SHA: sha,
          ALLRICE_B6_P27_WORKER_AUTHORIZED: '1',
          ALLRICE_B6_P27_WORKER_AUTHORIZED_SHA: sha,
          ALLRICE_B6_P27_WORKER_AUTHORIZED_PROVIDER: 'gemini',
          ALLRICE_B6_P27_WORKER_MAX_EXECUTIONS: '2',
        },
        sha,
      ),
    ).toThrow();
    expect(() => authorizeP27CodexWorker(authorized(), sha)).not.toThrow();
  });
  it('does not claim wire or cash bounds', () => {
    expect(P27_CODEX_ORDINARY_LIMITS.maxCostCents).toBeNull();
    expect(P27_CODEX_LIMIT_CAVEAT).toContain('does not prove');
    expect(P27_CODEX_COST_CAVEAT).toContain('not proof');
  });
  it.each([false, true])(
    'never repeats even after failure=%s',
    async (fails) => {
      const execute = vi.fn(async () => {
        if (fails) throw Error('synthetic');
        return 1;
      });
      const once = onceP27CodexWorker(execute);
      await once().catch(() => undefined);
      await expect(once()).rejects.toThrow('already_attempted');
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );
});
