import { describe, expect, it } from 'vitest';
import { localPreviewAvailability } from './local-preview-state';
const now = Date.parse('2026-09-09T07:00:00Z');
const base = {
  enabled: true,
  http: true,
  state: 'ready',
  stopRequested: false,
  hardDeadlineAt: new Date(now + 5000).toISOString(),
};
describe('private project preview presentation', () => {
  it('requires an enabled, ready HTTP service and an unexpired deadline', () => {
    expect(localPreviewAvailability(base, now).canRequest).toBe(true);
    for (const value of [
      { enabled: false },
      { http: false },
      { state: 'starting' },
      { state: 'unknown' },
      { state: 'stopped' },
      { stopRequested: true },
      { hardDeadlineAt: new Date(now).toISOString() },
      { hardDeadlineAt: 'bad' },
    ]) {
      expect(
        localPreviewAvailability({ ...base, ...value }, now).canRequest,
      ).toBe(false);
    }
    expect(
      localPreviewAvailability({ ...base, enabled: false }, now).visible,
    ).toBe(false);
  });
  it('distinguishes pending preparation from a recorded navigation; neither claims a live page', () => {
    const preview = {
      workspaceId: 'workspace',
      endpointId: 'endpoint',
      previewUrl: 'https://dedicated.invalid',
      pending: true,
    };
    expect(localPreviewAvailability({ ...base, preview }, now)).toMatchObject({
      canRequest: true,
      label: '申请打开预览',
    });
    expect(
      localPreviewAvailability(
        {
          ...base,
          preview: { ...preview, pending: false, operationId: 'operation' },
        },
        now,
      ),
    ).toMatchObject({
      canRequest: false,
      status: '预览导航已登记，请在浏览器工作台查看审批和执行状态。',
    });
  });
});
