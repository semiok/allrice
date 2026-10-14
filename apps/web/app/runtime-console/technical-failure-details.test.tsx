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
    model: {
      version: 1,
      truncated: false,
      failures: [
        {
          nativeSessionId: 'dsh-original',
          callId: id,
          phase: 'finish',
          code: 'PI_AI_ERROR',
          stopKind: 'error',
          inputUsageKnown: false,
          outputUsageKnown: false,
          settlementConfirmed: true,
        },
      ],
    },
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
      'finish',
      'PI_AI_ERROR',
      '不能记为零',
      '计算达到执行时限',
      'unknown',
      '已确认停止',
      '已清理',
    ])
      expect(html).toContain(text);
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
