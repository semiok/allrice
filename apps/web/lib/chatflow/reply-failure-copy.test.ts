import { describe, expect, it } from 'vitest';
import {
  modelGovernanceFailureText,
  nativeExecutionFailureText,
} from '@allrice/contracts';
import {
  plainFailureText,
  replyBudgetKept,
  replyFailureCopy,
  replyFailureFallback,
  savedGenericFailure,
} from './reply-failure-copy';

const banned = [
  'Token',
  'Codex',
  'DSH',
  'API',
  'Skill',
  '核实',
  '失败',
  '没有完成',
];
const codes = [
  'DOCUMENT_DELIVERY_INCOMPLETE',
  'FINAL_DELIVERY_RESPONSE_INVALID',
  'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
  'DSH_TRANSPORT',
  'DSH_TIMEOUT',
  'DSH_PI_AI_ERROR',
  'DSH_TURN_FAILED',
  'DSH_RECOVERY_REQUIRED',
  'DSH_EXECUTION_OUTCOME_UNKNOWN',
  'NATIVE_WAIT_RECOVERY_REJECTED',
  'NATIVE_WAIT_AUTHORITY_CHANGED',
  'NATIVE_WAIT_CONFIGURATION_CHANGED',
  'MODEL_OUTPUT_BUDGET_EXCEEDED',
  'MODEL_TOTAL_TOKEN_BUDGET_EXCEEDED',
  'MODEL_COST_BUDGET_EXCEEDED',
  'MODEL_TOKEN_USAGE_UNKNOWN',
  'MODEL_COST_USAGE_UNKNOWN',
  'MODEL_RUN_QUOTA_EXCEEDED',
  'MODEL_REQUEST_QUOTA_EXCEEDED',
  'MODEL_TOKEN_QUOTA_EXCEEDED',
  'MODEL_COST_QUOTA_EXCEEDED',
];

describe('plain copy for a reply that did not finish', () => {
  it.each(codes)('replaces the platform wording for %s', (code) => {
    const platform = modelGovernanceFailureText(code)!;
    expect(platform).toBeTruthy();
    const plain = plainFailureText(platform, code);
    expect(plain).toBe(replyFailureCopy(code));
    expect(plain).not.toBe(replyFailureFallback);
    expect(plain).toMatch(/未完成|待确认/);
    for (const word of banned) expect(plain).not.toContain(word);
  });

  it('keeps the specific copy when native diagnostics name a different failure', () => {
    // A masked disconnect is stored under DSH_UNKNOWN with the transport wording.
    expect(
      plainFailureText(
        nativeExecutionFailureText('DSH_TRANSPORT'),
        'DSH_UNKNOWN',
      ),
    ).toBe(replyFailureCopy('DSH_TRANSPORT'));
  });

  it('gives the stored catch-all text a next step by failure kind', () => {
    expect(plainFailureText(savedGenericFailure, 'JOB_TIMEOUT')).toContain(
      '拆小',
    );
    expect(plainFailureText(savedGenericFailure, 'RATE_LIMITED')).toBe(
      replyFailureFallback,
    );
    expect(plainFailureText(savedGenericFailure, null)).toBe(
      replyFailureFallback,
    );
    expect(
      plainFailureText(
        'Rice 暂时无法使用已引用的 Skill：Skill 文件校验失败。请重新安装或刷新该 Skill 后重试。',
        'SKILL_ARTIFACT_MISMATCH',
      ),
    ).toContain('技能');
  });

  it('asks for a refresh, never a resubmit, when the result is unknown', () => {
    for (const code of [
      'ASSISTANT_EXECUTION_UNRESOLVED',
      'DSH_EXECUTION_OUTCOME_UNKNOWN',
    ])
      expect(replyFailureCopy(code)).toContain('结果待确认，');
    expect(replyFailureCopy('ASSISTANT_EXECUTION_UNRESOLVED')).toContain(
      '请刷新查看',
    );
  });

  it('passes a real reply through and keeps the budget note plain', () => {
    expect(plainFailureText('已查到两项 CI 问题。', 'DSH_TRANSPORT')).toBe(
      '已查到两项 CI 问题。',
    );
    expect(plainFailureText(null, 'DSH_TRANSPORT')).toBeNull();
    for (const word of banned) expect(replyBudgetKept).not.toContain(word);
  });
});
