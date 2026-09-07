import { describe, expect, it } from 'vitest';

import {
  RuntimeUsageObservationSchema,
  type RuntimeUsageObservation,
} from './usage.ts';

const id = (suffix: number) =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

function observation(): RuntimeUsageObservation {
  return {
    contractVersion: 1,
    observationId: id(1),
    accountingId: id(2),
    task: {
      scope: { organizationId: id(3), workspaceId: id(4), projectId: null },
      chatSessionId: id(5),
      runId: id(6),
      rootRunId: id(6),
      parentRunId: null,
      frozenConfiguration: {
        employeeVersionId: id(7),
        digest: `sha256:${'a'.repeat(64)}`,
      },
    },
    source: { kind: 'provider', sourceId: 'provider-response-1' },
    accountingBoundary: { kind: 'run', runId: id(6) },
    aggregation: 'self_only',
    metric: 'input_tokens',
    unit: 'tokens',
    currency: null,
    mode: 'cumulative',
    quality: 'measured',
    amount: 120,
    state: 'spent',
    window: {
      id: id(8),
      startedAt: '2026-09-07T09:00:00Z',
      endedAt: '2026-09-07T09:01:00Z',
    },
    observedAt: '2026-09-07T09:01:01Z',
  };
}

describe('Runtime v2 usage observations (contract only)', () => {
  it('preserves explicit accounting identity, scope and cumulative semantics', () => {
    const input = observation();
    expect(RuntimeUsageObservationSchema.parse(input)).toEqual(input);
    // Parsing twice preserves the same fact, rather than adding its amount.
    expect(RuntimeUsageObservationSchema.parse(input).amount).toBe(120);
  });

  it.each(['measured', 'estimated'] as const)(
    'accepts explicit zero and safe positive integers for %s amounts',
    (quality) => {
      for (const amount of [0, 1, Number.MAX_SAFE_INTEGER]) {
        expect(
          RuntimeUsageObservationSchema.parse({
            ...observation(),
            quality,
            amount,
          }).amount,
        ).toBe(amount);
      }
    },
  );

  it('requires unknown usage to remain null without defaulting missing data to zero', () => {
    const input = { ...observation(), quality: 'unknown', amount: null };
    expect(RuntimeUsageObservationSchema.parse(input).amount).toBeNull();
    for (const amount of [0, 1]) {
      expect(
        RuntimeUsageObservationSchema.safeParse({ ...input, amount }).success,
      ).toBe(false);
    }
    const missing: Record<string, unknown> = { ...input };
    delete missing.amount;
    expect(RuntimeUsageObservationSchema.safeParse(missing).success).toBe(
      false,
    );
    for (const quality of ['measured', 'estimated']) {
      expect(
        RuntimeUsageObservationSchema.safeParse({ ...input, quality }).success,
      ).toBe(false);
    }
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity])(
    'rejects invalid/nonintegral/unsafe amount %s',
    (amount) => {
      expect(
        RuntimeUsageObservationSchema.safeParse({ ...observation(), amount })
          .success,
      ).toBe(false);
    },
  );

  it('binds root and Run boundary identities without inventing another root task', () => {
    const child = observation();
    child.task.parentRunId = id(6);
    child.task.runId = id(9);
    child.accountingBoundary = { kind: 'root_run', runId: id(6) };
    child.aggregation = 'includes_descendants';
    expect(RuntimeUsageObservationSchema.parse(child).aggregation).toBe(
      'includes_descendants',
    );
    expect(
      RuntimeUsageObservationSchema.safeParse({
        ...child,
        accountingBoundary: { kind: 'root_run', runId: id(9) },
      }).success,
    ).toBe(false);
    expect(
      RuntimeUsageObservationSchema.safeParse({
        ...child,
        accountingBoundary: { kind: 'run', runId: id(6) },
      }).success,
    ).toBe(false);
    expect(
      RuntimeUsageObservationSchema.safeParse({
        ...child,
        accountingBoundary: { kind: 'run', runId: id(9) },
      }).success,
    ).toBe(true);
  });

  it('requires operation metering to identify an attempt and exclude child aggregates', () => {
    const input = {
      ...observation(),
      accountingBoundary: {
        kind: 'operation',
        attempt: {
          operationId: id(10),
          attemptId: id(11),
          attemptNumber: 1,
          generation: 0,
          fence: 1,
        },
      },
    };
    expect(RuntimeUsageObservationSchema.safeParse(input).success).toBe(true);
    expect(
      RuntimeUsageObservationSchema.safeParse({
        ...input,
        aggregation: 'includes_descendants',
      }).success,
    ).toBe(false);
    expect(
      RuntimeUsageObservationSchema.safeParse({
        ...input,
        accountingBoundary: { kind: 'operation' },
      }).success,
    ).toBe(false);
    expect(
      RuntimeUsageObservationSchema.safeParse({
        ...input,
        accountingBoundary: {
          ...input.accountingBoundary,
          attempt: { ...input.accountingBoundary.attempt, attemptNumber: 0 },
        },
      }).success,
    ).toBe(false);
  });

  it('requires metric-specific units and explicit cost denomination', () => {
    const pairs = [
      ['input_tokens', 'tokens'],
      ['cached_input_tokens', 'tokens'],
      ['output_tokens', 'tokens'],
      ['model_calls', 'calls'],
      ['tool_calls', 'calls'],
      ['wall_time', 'milliseconds'],
      ['output_bytes', 'bytes'],
      ['cost', 'currency_microunits'],
    ];
    for (const [metric, unit] of pairs) {
      const input = {
        ...observation(),
        metric,
        unit,
        currency: metric === 'cost' ? 'USD' : null,
      };
      expect(RuntimeUsageObservationSchema.safeParse(input).success).toBe(true);
      expect(
        RuntimeUsageObservationSchema.safeParse({
          ...input,
          unit: unit === 'tokens' ? 'bytes' : 'tokens',
        }).success,
      ).toBe(false);
    }
    expect(
      RuntimeUsageObservationSchema.safeParse({
        ...observation(),
        currency: 'USD',
      }).success,
    ).toBe(false);
    for (const currency of [null, 'usd', '', 'USDT']) {
      expect(
        RuntimeUsageObservationSchema.safeParse({
          ...observation(),
          metric: 'cost',
          unit: 'currency_microunits',
          currency,
        }).success,
      ).toBe(false);
    }
  });

  it('keeps delta/cumulative, measurement quality and lifecycle state independent', () => {
    for (const state of ['reserved', 'spent', 'settled'] as const) {
      for (const mode of ['delta', 'cumulative'] as const) {
        const parsed = RuntimeUsageObservationSchema.parse({
          ...observation(),
          state,
          mode,
        });
        expect(parsed).toMatchObject({
          state,
          mode,
          accountingId: id(2),
          amount: 120,
        });
      }
    }
  });

  it('compares times as instants including offsets and rejects impossible windows', () => {
    const input = observation();
    input.window.startedAt = '2026-09-07T17:00:00+08:00';
    expect(RuntimeUsageObservationSchema.safeParse(input).success).toBe(true);
    expect(
      RuntimeUsageObservationSchema.safeParse({
        ...input,
        window: { ...input.window, endedAt: '2026-09-07T08:59:59Z' },
      }).success,
    ).toBe(false);
    expect(
      RuntimeUsageObservationSchema.safeParse({
        ...input,
        observedAt: '2026-09-07T09:00:59Z',
      }).success,
    ).toBe(false);
  });

  it('rejects unsupported versions, units, sources and missing explicit semantics', () => {
    for (const patch of [
      { contractVersion: 2 },
      { unit: 'credits' },
      { mode: 'total' },
      { quality: 'trusted' },
      { state: 'charged' },
      { aggregation: 'automatic' },
      { observationId: 'not-an-id' },
      { source: { kind: 'browser_report', sourceId: 'x' } },
      { source: { kind: 'provider', sourceId: '' } },
      { source: { kind: 'provider', sourceId: 'x'.repeat(241) } },
    ]) {
      expect(
        RuntimeUsageObservationSchema.safeParse({ ...observation(), ...patch })
          .success,
      ).toBe(false);
    }
    for (const field of [
      'accountingId',
      'aggregation',
      'metric',
      'currency',
      'mode',
      'quality',
      'state',
      'window',
    ] as const) {
      const input: Record<string, unknown> = { ...observation() };
      delete input[field];
      expect(RuntimeUsageObservationSchema.safeParse(input).success).toBe(
        false,
      );
    }
  });

  it('rejects unknown fields rather than accepting arbitrary raw provider payloads', () => {
    const input = observation();
    for (const candidate of [
      { ...input, rawPayload: { authorization: 'not-a-real-token' } },
      { ...input, source: { ...input.source, token: 'not-a-real-token' } },
      {
        ...input,
        accountingBoundary: { ...input.accountingBoundary, leaseToken: id(10) },
      },
      { ...input, window: { ...input.window, resetAutomatically: true } },
    ]) {
      expect(RuntimeUsageObservationSchema.safeParse(candidate).success).toBe(
        false,
      );
    }
  });
});
