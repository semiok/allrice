import { describe, expect, it } from 'vitest';
import {
  modelGovernanceFailureText,
  nativeExecutionFailureText,
} from '@allrice/contracts';
import {
  presentReplyFailure,
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
  '公司',
];
const contractCodes = [
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
const present = (
  code: string | null,
  text: string,
  nativeText: string | null = null,
) => presentReplyFailure({ code, text, nativeText, budgetWarning: false });

describe('plain copy for a reply that did not finish', () => {
  it.each(contractCodes)('replaces the stored wording for %s once', (code) => {
    const stored = modelGovernanceFailureText(code)!;
    expect(stored).toBeTruthy();
    const { body, notice } = present(code, stored);
    expect(body).toBe(replyFailureCopy(code));
    expect(body).not.toBe(replyFailureFallback);
    expect(body).toMatch(/未完成|待确认/);
    expect(notice).toBeNull();
    for (const word of banned) expect(body).not.toContain(word);
  });

  it('reads a stored disconnect the same in body and note, with or without diagnostics', () => {
    const transport = nativeExecutionFailureText('DSH_TRANSPORT')!;
    for (const failure of [
      present('DSH_UNKNOWN', transport),
      present('DSH_UNKNOWN', savedGenericFailure, transport),
    ])
      expect(failure).toEqual({
        body: replyFailureCopy('DSH_TRANSPORT'),
        notice: null,
      });
    // A kept reply stays; the note names the same failure.
    expect(present('DSH_UNKNOWN', '已查到四个 PR。', transport)).toEqual({
      body: '已查到四个 PR。',
      notice: replyFailureCopy('DSH_TRANSPORT'),
    });
  });

  it('adds nothing when the person stopped or declined the work', () => {
    expect(present(null, 'Rice 的这次执行已取消。')).toEqual({
      body: '这次任务已停止。',
      notice: null,
    });
    for (const [code, text] of [
      ['APPROVAL_REJECTED', '你已拒绝这一步操作，Rice 已停止该工作流。'],
      [
        'INPUT_NOT_ADOPTED',
        '本次输入未确认在原回合生效，不会自动作为下一轮任务执行。',
      ],
    ] as const)
      expect(present(code, text)).toEqual({ body: text, notice: null });
  });

  it.each([
    ['MODEL_RESOURCE_CONCURRENCY_EXCEEDED', '同时进行的任务太多'],
    ['PROVIDER_CIRCUIT_OPEN', 'AI 服务暂时不可用'],
    ['PROVIDER_KILL_SWITCH', 'AI 服务暂时不可用'],
    ['PROVIDER_NOT_RELEASED', 'AI 服务暂时不可用'],
    ['MODEL_RUNTIME_LIMIT_EXCEEDED', '运行时间超过上限'],
    ['JOB_TIMEOUT', '运行时间超过上限'],
    ['EMPLOYEE_ENQUEUE_FAILED', '没能开始'],
  ])('keeps a next step for the catch-all text under %s', (code, words) => {
    const { body, notice } = present(code, savedGenericFailure);
    expect(body).toContain(words);
    expect(body).toMatch(/再试/);
    expect(notice).toBeNull();
  });

  it('gives an unknown failure a neutral next step', () => {
    expect(present('RATE_LIMITED', savedGenericFailure).body).toBe(
      replyFailureFallback,
    );
    expect(present('RATE_LIMITED', '已完成的一段回答').notice).toBe(
      replyFailureFallback,
    );
    expect(replyFailureFallback).not.toContain('换个说法');
    expect(
      present(
        'EMPLOYEE_ENQUEUE_FAILED',
        'Rice 暂时无法开始这次执行，请稍后重试。',
      ).body,
    ).toBe(replyFailureCopy('EMPLOYEE_ENQUEUE_FAILED'));
  });

  it.each([
    'DSH_UNKNOWN',
    'DSH_EXECUTION_OUTCOME_UNKNOWN',
    'ASSISTANT_EXECUTION_UNRESOLVED',
    'NATIVE_WAIT_RECOVERY_REJECTED',
  ])(
    'never suggests sending the work again when %s leaves results unknown',
    (code) => {
      const copy = replyFailureCopy(code);
      expect(copy).toContain('结果待确认');
      expect(copy).not.toMatch(/再试|可以重新发起|换个说法/);
    },
  );

  it('keeps platform limits over a kept reply, and the budget note plain', () => {
    expect(present('MODEL_OUTPUT_BUDGET_EXCEEDED', '部分回答').body).toBe(
      replyFailureCopy('MODEL_OUTPUT_BUDGET_EXCEEDED'),
    );
    expect(
      presentReplyFailure({
        code: 'MODEL_OUTPUT_BUDGET_EXCEEDED',
        text: '完整回答',
        nativeText: null,
        budgetWarning: true,
      }).body,
    ).toBe('完整回答');
    for (const word of [...banned, '未完成'])
      expect(replyBudgetKept).not.toContain(word);
  });
});
