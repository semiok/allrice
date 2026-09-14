import { describe, expect, it } from 'vitest';
import {
  assertCandidate,
  assertExecutionAuthorization,
  isolatedEnvironment,
  parseArguments,
  strictDescendant,
  PROVIDER,
  RUN_LIMITS,
} from './p27-assistant-preflight.ts';
const sha = 'a'.repeat(40);
describe('P27 provider-free preflight safety', () => {
  it('requires explicit mode and a full candidate SHA', () => {
    expect(parseArguments(['--preflight', `--candidate-sha=${sha}`])).toEqual({
      mode: '--preflight',
      sha,
    });
    for (const args of [
      [],
      ['--execute'],
      ['--execute', '--candidate-sha=main'],
      ['--execute', `--candidate-sha=${sha}`, '--retry'],
      ['--execute', '--preflight'],
    ])
      expect(() => parseArguments(args)).toThrow('p27_arguments');
  });
  it('refuses mismatching or dirty candidates including untracked files', () => {
    expect(() => assertCandidate(sha, 'b'.repeat(40), '')).toThrow(
      'candidate_mismatch',
    );
    for (const status of [' M tracked.ts', '?? untracked.ts'])
      expect(() => assertCandidate(sha, sha, status)).toThrow('dirty_worktree');
    expect(() => assertCandidate(sha, sha, '')).not.toThrow();
  });
  it('binds authorization to this exact candidate and rejects ambient databases', () => {
    const authorized = {
      ALLRICE_B6_P27_PROVIDER_AUTHORIZED: '1',
      ALLRICE_B6_P27_AUTHORIZED_SHA: sha,
    };
    for (const env of [
      {},
      { ...authorized, ALLRICE_B6_P27_AUTHORIZED_SHA: 'b'.repeat(40) },
    ])
      expect(() => assertExecutionAuthorization(env, sha)).toThrow(
        'provider_not_authorized',
      );
    for (const key of ['DATABASE_URL', 'ALLRICE_TEST_DATABASE_URL'])
      expect(() =>
        assertExecutionAuthorization(
          { ...authorized, [key]: 'do-not-connect' },
          sha,
        ),
      ).toThrow('ambient_database_denied');
    expect(() => assertExecutionAuthorization(authorized, sha)).not.toThrow();
  });
  it('requires a strict canonical descendant, not a prefix/lookalike/root', () => {
    expect(strictDescendant('/dev/.local', '/dev/.local/smoke')).toBe(true);
    for (const value of [
      '/dev/.local',
      '/dev/.local-other/a',
      '/dev',
      '/prod/a',
    ])
      expect(strictDescendant('/dev/.local', value)).toBe(false);
  });
  it('does not forward arbitrary provider credentials or tool/environment overrides', () => {
    const result = isolatedEnvironment(
      {
        PATH: '/bin',
        HOME: '/synthetic',
        OPENAI_API_KEY: 'synthetic-secret',
        ALLRICE_DSH_CREDENTIALS_PATH: '/bad',
        ALLRICE_BRIDGE_TRANSPORT_ENABLED: '1',
        NODE_OPTIONS: '--import=/bad',
        DATABASE_URL: 'bad',
      },
      '/dev/allowed',
    );
    expect(result).not.toHaveProperty('OPENAI_API_KEY');
    expect(result).not.toHaveProperty('NODE_OPTIONS');
    expect(result).not.toHaveProperty('ALLRICE_DSH_CREDENTIALS_PATH');
    expect(result).not.toHaveProperty('DATABASE_URL');
    expect(result.ALLRICE_BRIDGE_TRANSPORT_ENABLED).toBe('0');
    expect(PROVIDER.route).toBe('openai-codex');
    expect(RUN_LIMITS.timeoutMs).toBe(180000);
    expect(RUN_LIMITS.maxCostCents).toBeNull();
  });
});
