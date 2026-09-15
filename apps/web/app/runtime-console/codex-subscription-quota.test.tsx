import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { CodexSubscriptionQuotaSnapshot } from '@allrice/contracts';
import {
  CodexSubscriptionQuota,
  codexQuotaFreshnessMs,
} from './codex-subscription-quota';

const now = Date.parse('2026-09-15T10:00:00.000Z');
function snapshot(): CodexSubscriptionQuotaSnapshot {
  return {
    source: 'codex_app_server',
    status: 'available',
    checkedAt: new Date(now - 10_000).toISOString(),
    accountFingerprint: `sha256:${'a'.repeat(64)}`,
    detailCode: 'codex_quota_read',
    buckets: [
      {
        limitId: 'codex',
        limitReached: false,
        windows: [
          {
            slot: 'primary',
            status: 'available',
            usedPercent: 60,
            windowDurationMins: 10_080,
            resetsAt: Math.floor(now / 1000) + 3600,
          },
          {
            slot: 'secondary',
            status: 'available',
            usedPercent: 100,
            windowDurationMins: 300,
            resetsAt: Math.floor(now / 1000) + 600,
          },
        ],
      },
    ],
  };
}
function render(quota?: CodexSubscriptionQuotaSnapshot | null) {
  return renderToStaticMarkup(
    <CodexSubscriptionQuota quota={quota} now={now} />,
  );
}

describe('Codex subscription quota card', () => {
  it('labels real durations regardless of slot and separates shared quota from internal limits', () => {
    const html = render(snapshot());
    expect(html).toContain('同一订阅账号共享的额度');
    expect(html).toContain('与平台内部月度限制分别计算');
    expect(html).toContain('7 天窗口（周额度）');
    expect(html).toContain('5 小时窗口');
    expect(html).toContain('剩余 40%');
    expect(html).toContain('已耗尽');
    expect(html).toContain('后台核对时间');
    expect(html).toContain('北京时间');
    expect(html).not.toContain('sha256');
  });

  it('never presents absent/error/stale snapshots as zero usage or unlimited quota', () => {
    const base = snapshot();
    for (const quota of [
      undefined,
      { ...base, status: 'error' as const, buckets: [] },
      {
        ...base,
        checkedAt: new Date(now - codexQuotaFreshnessMs - 1).toISOString(),
      },
      { ...base, checkedAt: new Date(now + 1000).toISOString() },
      { ...base, accountFingerprint: null },
    ]) {
      const html = render(quota);
      expect(html).toContain('当前剩余未知');
      expect(html).not.toContain('剩余 40%');
      expect(html).not.toContain('已用');
      expect(html).not.toContain('无限');
    }
  });

  it('expired reset time remains unknown, never assumes account has recovered', () => {
    const quota = snapshot();
    quota.buckets[0]!.windows[0].resetsAt = Math.floor(now / 1000) - 1;
    const html = render(quota);
    expect(html).toContain('剩余额度未知');
    expect(html).toContain('不视为已恢复');
    expect(html).not.toContain('剩余 40%');
  });

  it('shows an explicit service restriction even without numeric quota windows', () => {
    const quota = snapshot();
    quota.status = 'unknown';
    quota.buckets[0]!.limitReached = true;
    for (const window of quota.buckets[0]!.windows) {
      window.status = 'unknown';
      window.usedPercent = null;
      window.windowDurationMins = null;
      window.resetsAt = null;
    }
    const html = render(quota);
    expect(html).toContain('服务已报告达到使用限制');
    expect(html).toContain('时长未知的窗口');
    expect(html).toContain('重置时间未知');
    expect(html).not.toContain('周额度');
  });

  it('does not manufacture a weekly window when the service provides a custom duration', () => {
    const quota = snapshot();
    quota.buckets[0]!.windows[0].windowDurationMins = 15;
    expect(render(quota)).toContain('15 分钟窗口');
    expect(render(quota)).not.toContain('周额度');
  });
});
