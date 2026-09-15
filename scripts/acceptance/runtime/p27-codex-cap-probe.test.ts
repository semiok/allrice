import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  authorizeP27CodexCapProbe,
  parseP27CodexCapProbeResult,
} from './p27-codex-cap-probe.ts';

const sha = 'a'.repeat(40);
const root = resolve(import.meta.dirname, '../../..');
const authorized = () => ({
  ALLRICE_B6_P27_CODEX_CAP_PROBE_AUTHORIZED: '1',
  ALLRICE_B6_P27_CODEX_CAP_PROBE_AUTHORIZED_SHA: sha,
  ALLRICE_B6_P27_CODEX_CAP_PROBE_MAX_REQUESTS: '1',
  ALLRICE_B6_P27_CODEX_CAP_PROBE_SOFT_LIMIT_ACK: '1',
});

describe('standalone Codex cap-probe authorization (no live credentials)', () => {
  it.each(Object.keys(authorized()))('requires the exact %s ticket', (name) => {
    expect(() =>
      authorizeP27CodexCapProbe({ ...authorized(), [name]: 'wrong' }, sha),
    ).toThrow();
  });
  it('does not reuse previous provider or ordinary Worker opt-ins', () => {
    expect(() =>
      authorizeP27CodexCapProbe(
        {
          ALLRICE_B6_P27_PROVIDER_AUTHORIZED: '1',
          ALLRICE_B6_P27_AUTHORIZED_SHA: sha,
          ALLRICE_B6_P27_CODEX_WORKER_AUTHORIZED: '1',
          ALLRICE_B6_P27_CODEX_WORKER_AUTHORIZED_SHA: sha,
        },
        sha,
      ),
    ).toThrow();
  });
  it.each(['DATABASE_URL', 'ALLRICE_TEST_DATABASE_URL'])(
    'denies ambient %s',
    (name) => {
      expect(() =>
        authorizeP27CodexCapProbe(
          { ...authorized(), [name]: 'forbidden' },
          sha,
        ),
      ).toThrow();
    },
  );
  it('accepts only the independently scoped ticket', () => {
    expect(() => authorizeP27CodexCapProbe(authorized(), sha)).not.toThrow();
  });

  it('discards arbitrary native/provider text before report persistence', () => {
    const result = parseP27CodexCapProbeResult(
      `CODEX_CAP_PROBE_RESULT=${JSON.stringify({
        outcome: 'cap_field_rejected',
        httpStatus: 400,
        fieldRejected: true,
        errorType: 'unsupported_output_cap',
        errorBody: 'private-error-body',
        accessToken: 'private-token',
        accountId: 'private-account',
        usage: { inputTokens: 'private-field', outputTokens: 4 },
      })}\n`,
    );
    expect(result.outcome).toBe('cap_field_rejected');
    expect(result.usage).toBeNull();
    expect(JSON.stringify(result)).not.toContain('private-');
  });

  it.each([
    {
      name: 'empty store',
      document: 'version: 1\nrefs: {}\nrecords: {}\n',
      outcome: 'subscription_grant_required',
      shapeValidated: false,
    },
    {
      name: 'expired OAuth grant in the actual DSH record shape',
      document: JSON.stringify({
        version: 1,
        refs: {},
        records: {
          'llm-pi-ai/openai-codex': {
            kind: 'grant',
            payload: {
              type: 'oauth',
              access: 'synthetic-expired-access',
              refresh: 'synthetic-refresh',
              expires: 1,
            },
          },
        },
      }),
      outcome: 'unexpired_subscription_grant_required',
      shapeValidated: true,
    },
    {
      name: 'legacy migration forbidden by filesystem write denial',
      document: 'SYNTHETIC_KEY: synthetic-must-not-be-migrated\n',
      outcome: 'host_failed',
      shapeValidated: undefined,
    },
  ])(
    'boots read-only native host: $name',
    async ({ document, outcome, shapeValidated }) => {
      const temporary = await mkdtemp(join(tmpdir(), 'allrice-cap-host-test-'));
      try {
        const file = join(temporary, '.credentials.yaml');
        // Test-owned, synthetic, non-secret file only. The native child cannot write.
        await writeFile(file, document, {
          mode: 0o600,
        });
        const { stdout } = await promisify(execFile)(
          process.execPath,
          [
            '--permission',
            `--allow-fs-read=${root}`,
            `--allow-fs-read=${temporary}`,
            join(
              root,
              'apps/worker/dsh/allrice-codex-subscription-cap-probe-host.mjs',
            ),
          ],
          {
            cwd: temporary,
            timeout: 10_000,
            encoding: 'utf8',
            env: {
              PATH: process.env.PATH,
              DSH_HOME: temporary,
              DSH_CWD: temporary,
              DSH_CREDENTIALS_PATH: file,
              ALLRICE_CODEX_CAP_PROBE_CONFIRMATION:
                'run-one-codex-subscription-cap-probe',
              ALLRICE_CODEX_CAP_PROBE_SHA: sha,
            },
          },
        );
        const line = stdout
          .split('\n')
          .find((value) => value.startsWith('CODEX_CAP_PROBE_RESULT='));
        expect(line).toBeDefined();
        const result = JSON.parse(
          line!.slice('CODEX_CAP_PROBE_RESULT='.length),
        );
        expect(result.outcome).toBe(outcome);
        expect(result.credentialShapeValidated).toBe(shapeValidated);
        expect(await readFile(file, 'utf8')).toBe(document);
        expect(JSON.stringify(result)).not.toContain('synthetic-');
        if (outcome !== 'host_failed') {
          expect(result).toMatchObject({ payloadCount: 0, httpStatus: null });
        }
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
  );
});
