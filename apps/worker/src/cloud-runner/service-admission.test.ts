import { describe, expect, it } from 'vitest';
import type { CloudExecutionPayload } from '@allrice/contracts';
import { cloudServiceAdmissionTimeout } from './service-admission.js';

describe('cloud service readiness includes frozen web preparation', () => {
  const now = Date.parse('2026-10-08T00:00:00Z');
  const deadline = (ms: number) => new Date(now + ms).toISOString();
  const payload = (resourceProfile?: 'standard' | 'web-development') =>
    ({
      kind: 'project',
      arguments: {
        limits: {
          timeoutMs: resourceProfile === 'web-development' ? 600_000 : 60_000,
        },
        projectPreparation: { manager: 'pnpm', resourceProfile },
      },
    }) as unknown as CloudExecutionPayload;

  it('allows the measured four-minute Next preparation before readiness', () => {
    expect(
      cloudServiceAdmissionTimeout(
        payload('web-development'),
        deadline(1_200_000),
        now,
      ),
    ).toBe(660_000);
  });
  it.each([undefined, 'standard'] as const)(
    'keeps ordinary %s admission at two minutes',
    (profile) => {
      expect(
        cloudServiceAdmissionTimeout(
          payload(profile),
          deadline(1_200_000),
          now,
        ),
      ).toBe(120_000);
    },
  );
  it('never extends the originating task deadline', () => {
    expect(
      cloudServiceAdmissionTimeout(
        payload('web-development'),
        deadline(180_000),
        now,
      ),
    ).toBe(180_000);
  });
  it.each([deadline(-1), 'invalid'])(
    'expires immediately for unavailable deadline %s',
    (value) => {
      expect(
        cloudServiceAdmissionTimeout(payload('web-development'), value, now),
      ).toBe(1);
    },
  );
});
