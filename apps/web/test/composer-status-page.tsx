import type { ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatComposer } from '../app/chatflow/chat-composer';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';

const noop = () => {};
const base: ComponentProps<typeof ChatComposer> = {
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
  bridgeConnectionState: 'offline',
  localWorkspaceOnline: false,
};
const cases: [string, Partial<ComponentProps<typeof ChatComposer>>][] = [
  ['offline', {}],
  [
    'folder',
    {
      bridgeConnectionState: 'online',
      localWorkspaceOnline: true,
      localWorkspaceLabel: '销售周报',
    },
  ],
  ['tidying', { bridgeConnectionState: 'unknown', contextCompacting: true }],
];

if (new URLSearchParams(location.search).get('theme') === 'dark')
  document.body.setAttribute('data-ds-dark-theme', '');
createRoot(document.getElementById('root')!).render(
  <main style={{ display: 'grid', gap: 24, padding: 16 }}>
    {cases.map(([name, props]) => (
      <section key={name} data-case={name}>
        <ChatComposer {...base} {...props} />
      </section>
    ))}
  </main>,
);
