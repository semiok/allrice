import { describe, expect, it } from 'vitest';
import {
  fixtureCleanupFlags,
  assertCandidate,
  assertExecutionAuthorization,
  isolatedEnvironment,
  parseArguments,
  providerExecutionEligibility,
  selectedProvider,
  strictDescendant,
  PROVIDER,
  RUN_LIMITS,
} from './p27-assistant-preflight.ts';
const sha = 'a'.repeat(40);
describe('P27 provider-free preflight safety', () => {
  it('does not call a valid source manifest permission to run the unsupported pinned Codex assistant route', () => {
    expect(providerExecutionEligibility()).toEqual({
      eligible: false,
      reason: 'ASSISTANT_PROVIDER_OUTPUT_BOUND_UNSUPPORTED',
    });
  });
  it('does not treat an undefined fixture after attempted initialization as successful cleanup', () => {
    expect(fixtureCleanupFlags(false)).toEqual({
      schemaRemoved: true,
      fixtureStorageRemoved: true,
      fixtureConnectionsClosed: true,
    });
    expect(fixtureCleanupFlags(true)).toEqual({
      schemaRemoved: false,
      fixtureStorageRemoved: false,
      fixtureConnectionsClosed: false,
    });
    expect(
      fixtureCleanupFlags(true, {
        schema: `p25_${'a'.repeat(32)}`,
        schemaRemoved: true,
        storageRoot: null,
        storageRemoved: false,
        databaseClosed: true,
        adminClosed: true,
      }),
    ).toEqual({
      schemaRemoved: true,
      fixtureStorageRemoved: false,
      fixtureConnectionsClosed: true,
    });
  });
  it('requires explicit mode and a full candidate SHA', () => {
    expect(parseArguments(['--preflight', `--candidate-sha=${sha}`])).toEqual({
      mode: '--preflight',
      sha,
      providerRoute: 'openai-codex',
    });
    for (const args of [
      [],
      ['--execute'],
      ['--execute', '--candidate-sha=main'],
      ['--execute', `--candidate-sha=${sha}`, '--retry'],
      ['--execute', '--preflight'],
      ['--execute', `--candidate-sha=${sha}`, '--provider=unknown'],
      [
        '--execute',
        `--candidate-sha=${sha}`,
        '--provider=gemini',
        '--provider=gemini',
      ],
      ['--execute', '--execute', `--candidate-sha=${sha}`],
      ['--execute', `--candidate-sha=${sha}`, `--candidate-sha=${sha}`],
    ])
      expect(() => parseArguments(args)).toThrow('p27_arguments');
  });
  it('requires explicit Gemini selection and provider-bound authorization, never falls back from Codex', () => {
    expect(
      parseArguments([
        '--execute',
        `--candidate-sha=${sha}`,
        '--provider=gemini',
      ]),
    ).toEqual({ mode: '--execute', sha, providerRoute: 'gemini' });
    expect(
      providerExecutionEligibility(selectedProvider('gemini')).eligible,
    ).toBe(true);
    expect(providerExecutionEligibility().eligible).toBe(false);
    const env = {
      ALLRICE_B6_P27_PROVIDER_AUTHORIZED: '1',
      ALLRICE_B6_P27_AUTHORIZED_SHA: sha,
    };
    expect(() => assertExecutionAuthorization(env, sha, 'gemini')).toThrow(
      'provider_route_not_authorized',
    );
    expect(() =>
      assertExecutionAuthorization(
        { ...env, ALLRICE_B6_P27_AUTHORIZED_PROVIDER: 'openai-codex' },
        sha,
        'gemini',
      ),
    ).toThrow('provider_route_not_authorized');
    expect(() =>
      assertExecutionAuthorization(
        { ...env, ALLRICE_B6_P27_AUTHORIZED_PROVIDER: 'gemini' },
        sha,
        'openai-codex',
      ),
    ).toThrow('provider_route_not_authorized');
    expect(() =>
      assertExecutionAuthorization(
        { ...env, ALLRICE_B6_P27_AUTHORIZED_PROVIDER: 'gemini' },
        sha,
        'gemini',
      ),
    ).not.toThrow();
  });
  it('only passes the prevalidated Gemini file and enables Gemini in the isolated child environment', () => {
    const env = {
      ALLRICE_DSH_CREDENTIALS_JSON: 'not-forwarded',
      ALLRICE_DSH_CREDENTIALS_FILE: '/unselected',
      GEMINI_API_KEY: 'not-forwarded',
    };
    expect(() =>
      isolatedEnvironment(env, '/dev/allowed', { providerRoute: 'gemini' }),
    ).toThrow('gemini_credential_file_required');
    const child = isolatedEnvironment(env, '/dev/allowed', {
      providerRoute: 'gemini',
      credentialFile: '/dev/allowed/selected.json',
    });
    expect(child.ALLRICE_GEMINI_API_ENABLED).toBe('1');
    expect(child.ALLRICE_DSH_CREDENTIALS_FILE).toBe(
      '/dev/allowed/selected.json',
    );
    expect(child).not.toHaveProperty('ALLRICE_DSH_CREDENTIALS_JSON');
    expect(child).not.toHaveProperty('GEMINI_API_KEY');
    expect(isolatedEnvironment(env, '/dev/allowed')).not.toHaveProperty(
      'ALLRICE_DSH_CREDENTIALS_FILE',
    );
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
