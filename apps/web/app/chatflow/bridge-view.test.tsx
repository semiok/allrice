import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatComposer } from './chat-composer';
import { projectBridgeView } from './bridge-view';
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

function render(devices: BridgeDevice[], known = true) {
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
    nativeContextStatus: null,
    pendingAttachments: [],
    providerLabel: 'Synthetic provider',
    uploadVisibility: 'private',
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
    onUploadVisibilityChange: noop,
    ...view,
  };
  return renderToStaticMarkup(<ChatComposer {...props} />);
}

describe('Bridge connection and local workspace presentation', () => {
  it('keeps an online device green without claiming it has a workspace', () => {
    const html = render([device('online')]);
    expect(html).toContain('aria-label="Bridge 在线 · 未选择工作区"');
    expect(html).toMatch(/class="[^"]*localWorkspaceOnline[^"]*"/);
    expect(html).not.toContain('本地工作区离线');
  });
  it('shows a connected authorized folder', () => {
    const html = render([device('online', true)]);
    expect(html).toContain('aria-label="本地工作区 Synthetic Folder"');
    expect(html).toContain('Rice Bridge 在线，本地工作区已连接');
  });
  it('does not show remembered workspace names when offline', () => {
    const html = render([device('offline', true)]);
    expect(html).toContain('aria-label="Bridge 离线"');
    expect(html).not.toContain('Synthetic Folder');
  });
  it('does not mistake request failure or initial loading for confirmed offline', () => {
    const html = render([device('online', true)], false);
    expect(html).toContain('aria-label="Bridge 状态待确认"');
    expect(html).not.toContain('Synthetic Folder');
    expect(html).not.toContain('aria-label="Bridge 离线"');
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
