import { describe, expect, it } from 'vitest';
import {
  authorizeP27CodexAssistants,
  codexAssistantsDiagnostics,
  parseP27CodexAssistantsArguments,
  P27CodexAssistantsCheckError,
  P27_CODEX_ASSISTANT_LIMITS,
} from './p27-codex-assistants-preflight.ts';
const sha = 'a'.repeat(40);
const auth = () => ({
  ALLRICE_B6_P27_CODEX_ASSISTANTS_AUTHORIZED: '1',
  ALLRICE_B6_P27_CODEX_ASSISTANTS_AUTHORIZED_SHA: sha,
  ALLRICE_B6_P27_CODEX_ASSISTANTS_MAX_EXECUTIONS: '2',
  ALLRICE_B6_P27_CODEX_ASSISTANTS_SOFT_LIMIT_ACK: '1',
  ALLRICE_B6_P27_CODEX_ASSISTANTS_SUBSCRIPTION_ONLY: '1',
});
describe('dedicated subscription two-Worker authorization, no providers', () => {
  it.each(Object.keys(auth()))('requires exact %s', (key) => {
    expect(() =>
      authorizeP27CodexAssistants({ ...auth(), [key]: 'no' }, sha),
    ).toThrow();
  });
  it.each(['DATABASE_URL', 'ALLRICE_TEST_DATABASE_URL'])(
    'rejects ambient %s',
    (key) => {
      expect(() =>
        authorizeP27CodexAssistants(
          { ...auth(), [key]: 'postgres://live' },
          sha,
        ),
      ).toThrow();
    },
  );
  it('never accepts ordinary or Gemini tickets', () => {
    expect(() =>
      authorizeP27CodexAssistants(
        {
          ALLRICE_B6_P27_CODEX_WORKER_AUTHORIZED: '1',
          ALLRICE_B6_P27_CODEX_WORKER_AUTHORIZED_SHA: sha,
          ALLRICE_B6_P27_CODEX_WORKER_MAX_EXECUTIONS: '1',
          ALLRICE_B6_P27_WORKER_AUTHORIZED: '1',
          ALLRICE_B6_P27_WORKER_AUTHORIZED_SHA: sha,
          ALLRICE_B6_P27_WORKER_MAX_EXECUTIONS: '2',
        },
        sha,
      ),
    ).toThrow();
    expect(() => authorizeP27CodexAssistants(auth(), sha)).not.toThrow();
  });
  it('requires explicit Codex even for preflight', () => {
    for (const provider of [undefined, 'gemini']) {
      expect(() =>
        parseP27CodexAssistantsArguments([
          '--preflight',
          `--candidate-sha=${sha}`,
          ...(provider ? [`--provider=${provider}`] : []),
        ]),
      ).toThrow();
    }
    expect(
      parseP27CodexAssistantsArguments([
        '--preflight',
        `--candidate-sha=${sha}`,
        '--provider=openai-codex',
      ]).providerRoute,
    ).toBe('openai-codex');
    expect(P27_CODEX_ASSISTANT_LIMITS.maxCostCents).toBeNull();
  });
  it('retains only fixed local diagnostic codes, never model bodies', () => {
    expect(
      codexAssistantsDiagnostics(
        new P27CodexAssistantsCheckError('subscription_identity'),
      ).acceptanceCheck,
    ).toBe('subscription_identity');
    const proof = codexAssistantsDiagnostics(
      new Error('private-provider-body'),
    );
    expect(proof.acceptanceCheck).toBeNull();
    expect(JSON.stringify(proof)).not.toContain('private-provider-body');
  });
});
