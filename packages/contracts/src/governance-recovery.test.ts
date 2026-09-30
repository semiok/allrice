import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  modelGovernanceFailureText,
  nativeExecutionDiagnosticFailureText,
  ReviewSubscriptionUsageBudgetInputSchema,
} from './governance.ts';
describe('unknown usage recovery presentation and input', () => {
  it('explains a masked root failure without changing its code or accepting child/stale diagnoses', () => {
    const root = 'dsh-synthetic-root';
    const entry = {
      nativeSessionId: root,
      callId: randomUUID(),
      phase: 'finish',
      code: 'TRANSPORT',
      stopKind: 'error',
      inputUsageKnown: false,
      outputUsageKnown: false,
      settlementConfirmed: true,
    };
    const payload = {
      threadId: root,
      assistantDiagnostics: { version: 1, failures: [entry], truncated: false },
    };
    expect(
      nativeExecutionDiagnosticFailureText(
        'DSH_UNKNOWN',
        payload,
        'assistant_model_unknown_no_replay',
      ),
    ).toContain('模型连接中断');
    expect(
      nativeExecutionDiagnosticFailureText(
        'ASSISTANT_BUDGET_EXHAUSTED',
        payload,
        'assistant_model_unknown_no_replay',
      ),
    ).toBeNull();
    for (const patch of [
      { failures: [{ ...entry, nativeSessionId: 'dsh-another-root' }] },
      { failures: [{ ...entry, phase: 'usage', code: 'USAGE_INCOMPLETE' }] },
      {
        failures: [entry, { ...entry, callId: randomUUID(), code: 'UNKNOWN' }],
      },
      { failures: [{ ...entry, privateProviderText: 'secret' }] },
      { truncated: true },
    ])
      expect(
        nativeExecutionDiagnosticFailureText(
          'DSH_UNKNOWN',
          {
            ...payload,
            assistantDiagnostics: { ...payload.assistantDiagnostics, ...patch },
          },
          'assistant_model_unknown_no_replay',
        ),
      ).toBeNull();
    expect(
      nativeExecutionDiagnosticFailureText(
        'DSH_UNKNOWN',
        payload,
        'unrelated_unknown',
      ),
    ).toBeNull();
  });
  it.each([
    ['DSH_TRANSPORT', '模型连接中断'],
    ['DSH_TIMEOUT', '等待模型响应超时'],
    ['DSH_PI_AI_ERROR', '模型响应失败'],
    ['DSH_RECOVERY_REQUIRED', '原执行记录尚不能安全恢复'],
  ])(
    'explains %s with preserved records and no whole-task replay',
    (code, copy) => {
      expect(modelGovernanceFailureText(code)).toContain(copy);
      expect(modelGovernanceFailureText(code)).toContain('已保留');
    },
  );

  it('distinguishes unknown use, internal quota and actual provider problems', () => {
    expect(modelGovernanceFailureText('MODEL_TOKEN_USAGE_UNKNOWN')).toContain(
      '反复重试不会解除',
    );
    expect(
      modelGovernanceFailureText('MODEL_TOKEN_USAGE_UNKNOWN'),
    ).not.toContain('额度已用完');
    expect(modelGovernanceFailureText('MODEL_TOKEN_QUOTA_EXCEEDED')).toContain(
      '不是 Codex 周额度',
    );
    expect(modelGovernanceFailureText('MODEL_COST_USAGE_UNKNOWN')).toContain(
      '费用尚未核对',
    );
    expect(modelGovernanceFailureText('UNRECOGNIZED_SECRET_ERROR')).toBeNull();
  });
  it('requires explicit acceptance, integer hold and a reason; rejects spoofed scope', () => {
    const data = {
      decisionId: randomUUID(),
      reservedTokens: 1_000_000,
      reason:
        'Administrator accepts unknown usage without rewriting historical actuals',
      acceptUnknownUsage: true,
    };
    expect(
      ReviewSubscriptionUsageBudgetInputSchema.safeParse(data).success,
    ).toBe(true);
    for (const patch of [
      { acceptUnknownUsage: undefined },
      { acceptUnknownUsage: false },
      { reservedTokens: 0 },
      { reservedTokens: 0.5 },
      { reason: '' },
      { organizationId: randomUUID() },
      { usageComplete: true },
    ])
      expect(
        ReviewSubscriptionUsageBudgetInputSchema.safeParse({
          ...data,
          ...patch,
        }).success,
      ).toBe(false);
  });
});
