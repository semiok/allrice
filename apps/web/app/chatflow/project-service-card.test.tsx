import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectServiceView } from '@allrice/contracts';
vi.mock('./native-html-preview', () => ({ NativeHtmlPreview: () => null }));
import { ProjectServiceCard } from './project-service-card';
const markup = (patch: Partial<ProjectServiceView>) =>
  renderToStaticMarkup(
    createElement(ProjectServiceCard, {
      service: {
        id: 'service',
        state: 'stopped',
        backend: 'cloud',
        expiresAt: '2026-10-11T12:00:00Z',
        stopped: true,
        stopRequested: false,
        canRenew: false,
        ...patch,
      } as ProjectServiceView,
      workspaceId: 'workspace',
      tenantHeaders: {},
      onChanged: () => {},
    }),
  );
describe('preview stop evidence presentation', () => {
  it('does not call a stop intent a physical stop', () => {
    const text = markup({
      stopped: false,
      stopRequested: true,
      state: 'stopping',
      stopReason: 'user_requested',
    });
    expect(text).toContain('正在等待运行环境确认');
    expect(text).not.toContain('已按请求停止预览');
  });
  it('presents confirmed cause and retained source without inventing a retry', () => {
    const text = markup({ stopReason: 'control_timeout' });
    expect(text).toContain('控制请求超时');
    expect(text).toContain('已保存的源码和成果仍可下载');
  });
  it('keeps historical missing causes unknown', () => {
    expect(markup({ stopReason: 'unknown' })).toContain('未记录具体停止原因');
    expect(markup({})).not.toContain('已按请求停止预览');
  });
});
