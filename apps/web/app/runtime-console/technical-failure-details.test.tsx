import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TechnicalRecordSchema } from '@allrice/database/technical-contracts';
import { TechnicalFailureDetails } from './technical-failure-details';

const id = '11111111-1111-4111-8111-111111111111';
const record = TechnicalRecordSchema.parse({
  kind: 'run',
  id,
  runId: id,
  jobId: null,
  organizationId: id,
  workspaceId: id,
  status: 'failed',
  errorCode: 'DSH_PI_AI_ERROR',
  action: null,
  category: null,
  observedAt: '2026-10-14T08:35:13.000Z',
  failureDetails: {
    cloud: [
      {
        operationId: id,
        status: 'unknown',
        reason: 'deadline',
        exitCode: 137,
        stopped: true,
        cleanupConfirmed: true,
      },
    ],
    cloudTruncated: false,
  },
});
describe('technical failure attribution', () => {
  it('shows distinct facts without treating a generic provider error as a proven upstream defect', () => {
    const html = renderToStaticMarkup(
      <TechnicalFailureDetails record={record} />,
    );
    for (const text of [
      '根因尚未确认',
      '不能据此认定',
      '计算达到执行时限',
      'unknown',
      '已确认停止',
      '已清理',
    ])
      expect(html).toContain(text);
  });
  it('shows the categorized safe original without a cause-unknown disclaimer, including recovered retries', () => {
    for (const category of ['auth', 'unknown'] as const) {
      const html = renderToStaticMarkup(
        <TechnicalFailureDetails
          record={{
            ...record,
            status: 'succeeded',
            modelFailures: [
              { category, upstreamMessage: 'Safe original <provider failure>' },
            ],
          }}
        />,
      );
      expect(html).toContain('Safe original &lt;provider failure&gt;');
      expect(html).not.toContain('根因尚未确认');
      expect(html).not.toContain('不能据此认定');
      expect(html).toContain(
        category === 'auth'
          ? '模型服务认证或授权失败。请联系管理员检查授权配置，反复重试无法修复认证问题。'
          : '模型服务返回了未归类的错误',
      );
    }
  });
  it('keeps historical records without diagnostics compatible', () => {
    expect(
      renderToStaticMarkup(
        <TechnicalFailureDetails
          record={{ ...record, failureDetails: undefined }}
        />,
      ),
    ).toBe('');
  });
});
