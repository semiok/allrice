import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatComposer } from './chat-composer';
import {
  projectBridgeView,
  bridgeCapabilityRows,
  bridgeWorkspaceIssue,
  bridgePreparationLabel,
} from './bridge-view';
import type { BridgeDevice } from './chatflow-types';

const device = (
  status: BridgeDevice['status'],
  selected = false,
): BridgeDevice => ({
  id: `synthetic-${status}-${selected}`,
  name: 'Synthetic Bridge',
  platform: 'macos-arm64',
  status,
  lastSeenAt: '2026-09-08T12:00:00.000Z',
  folderGrants: selected
    ? [{ id: 'synthetic-grant', label: 'Synthetic Folder' }]
    : [],
});

function render(
  devices: BridgeDevice[],
  known = true,
  overrides: Partial<ComponentProps<typeof ChatComposer>> = {},
) {
  const view = projectBridgeView(devices, known);
  const noop = () => {};
  const props: ComponentProps<typeof ChatComposer> = {
    employeeName: 'Rice',
    attachmentMenuOpen: false,
    busy: false,
    composerInput: { current: null },
    composing: { current: false },
    draft: '',
    error: '',
    fileInput: { current: null },
    isRunning: false,
    pendingAttachments: [],
    onAttachmentMenuOpenChange: noop,
    onCancelRun: noop,
    onDraftChange: noop,
    onLoadBridgeDevices: noop,
    onOpenAttachment: noop,
    onOpenWorkspaceFiles: noop,
    onRemoveAttachment: noop,
    onRetryAttachment: noop,
    onSendMessage: noop,
    onUploadAttachments: noop,
    ...view,
    ...overrides,
  };
  return renderToStaticMarkup(<ChatComposer {...props} />);
}

describe('Bridge connection and local workspace presentation', () => {
  it('keeps the remembered grant but does not claim local access when Bridge reports it missing', () => {
    const current = device('online', true);
    current.readiness = [
      {
        capability: 'local.fs.read',
        state: 'unsupported',
        reason: 'folder_missing',
        missing: ['folder_missing'],
        versions: {},
        observedAt: current.lastSeenAt,
      },
    ];
    expect(projectBridgeView([current])).toMatchObject({
      bridgeConnectionState: 'online',
      localWorkspaceOnline: false,
      localWorkspaceLabel: undefined,
    });
    expect(bridgeWorkspaceIssue(current)).toContain('重新选择');
    expect(current.folderGrants).toHaveLength(1);
    current.readiness[0]!.state = 'ready';
    current.readiness[0]!.reason = 'ready';
    expect(projectBridgeView([current]).localWorkspaceOnline).toBe(true);
  });
  it('shows byte progress and retries without claiming download means readiness', () => {
    const progress = {
      component: 'python' as const,
      stage: 'downloading' as const,
      receivedBytes: 2 * 1024 ** 2,
      expectedBytes: 100 * 1024 ** 2,
      attempt: 2,
      resumed: true,
      updatedAt: new Date().toISOString(),
    };
    expect(bridgePreparationLabel(progress)).toBe(
      '正在下载 · 2.0 / 100.0 MB · 第 2 次尝试 · 续传中',
    );
    expect(
      bridgePreparationLabel({
        ...progress,
        stage: 'failed',
        reason: 'RUNTIME_DOWNLOAD_STALLED',
      }),
    ).toContain('下载长时间没有进展');
  });
  it('shows preparation and absent Office separately from connected presence', () => {
    const current = device('online', true);
    current.readiness = [
      {
        capability: 'local.browser',
        state: 'preparing',
        reason: 'runtime_preparing',
        missing: [],
        versions: { bridge: 'fixture' },
        observedAt: current.lastSeenAt,
      },
      {
        capability: 'local.office',
        state: 'unsupported',
        reason: 'office_not_implemented',
        missing: ['office_local_adapter'],
        versions: { bridge: 'fixture' },
        observedAt: current.lastSeenAt,
      },
    ];
    expect(projectBridgeView([current]).bridgeConnectionState).toBe('online');
    expect(bridgeCapabilityRows(current)).toMatchObject([
      {
        capability: 'local.browser',
        stateLabel: '准备中',
        reason: '正在准备运行环境，新任务等待本机。',
      },
      {
        capability: 'local.office',
        stateLabel: '尚未就绪',
        reason: '本地 Office 执行尚未交付；现有云端 Office 可用。',
      },
    ]);
  });
  it('says only that the conversation is being tidied, without usage figures', () => {
    const html = render([], true, { contextCompacting: true });
    expect(html).toContain('正在整理对话，完成后继续');
    for (const word of ['上下文占用', 'DSH', 'tokens', '%'])
      expect(html).not.toContain(word);
    expect(render([], true, { contextCompacting: false })).not.toContain(
      '正在整理对话',
    );
  });
  it('keeps an online device green without claiming it has a workspace', () => {
    const html = render([device('online')]);
    expect(html).toContain('电脑已连接 · 未选文件夹');
    expect(html).toMatch(/class="[^"]*localWorkspaceOnline[^"]*"/);
    expect(html).not.toContain('本地工作区离线');
  });
  it('shows a connected authorized folder', () => {
    const html = render([device('online', true)]);
    expect(html).toContain('aria-label="电脑已连接，文件夹 Synthetic Folder"');
    expect(html).toContain('可以处理文件夹「Synthetic Folder」里的文件');
  });
  it('does not show remembered workspace names when offline', () => {
    const html = render([device('offline', true)]);
    // Not connected is a normal state: neutral wording, no red, no Bridge.
    expect(html).toContain('>电脑未连接<');
    expect(html).toMatch(/class="[^"]*localWorkspaceOffline[^"]*"/);
    expect(html).not.toContain('Bridge');
    expect(html).not.toContain('Synthetic Folder');
  });
  it('does not mistake request failure or initial loading for confirmed offline', () => {
    const html = render([device('online', true)], false);
    expect(html).toContain('正在确认电脑连接');
    expect(html).not.toContain('Synthetic Folder');
    expect(html).not.toContain('电脑未连接');
  });
  it('ignores revoked devices and prefers an online grant over old offline grants', () => {
    expect(
      projectBridgeView([device('revoked', true)]).bridgeConnectionState,
    ).toBe('offline');
    const current = device('online', true);
    expect(
      projectBridgeView([device('offline', true), current])
        .selectedBridgeDevice,
    ).toBe(current);
    expect(
      projectBridgeView([device('offline', true), device('online')]),
    ).toMatchObject({
      bridgeConnectionState: 'online',
      localWorkspaceOnline: false,
      localWorkspaceLabel: undefined,
    });
  });
});
