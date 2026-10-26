import type { ComponentProps, CSSProperties } from 'react';
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
    'connected',
    { bridgeConnectionState: 'online', localWorkspaceOnline: false },
  ],
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
  // The chat column the composer sits in: its page background and width.
  <main
    style={
      {
        display: 'grid',
        gap: 24,
        padding: 16,
        minHeight: '100vh',
        background: 'var(--dsw-alias-bg-base)',
        '--dsh-composer-card-max-width': '760px',
        '--dsh-chat-content-width': '760px',
      } as CSSProperties
    }
  >
    {cases.map(([name, props]) => (
      <section key={name} data-case={name} style={{ minWidth: 0 }}>
        <ChatComposer {...base} {...props} />
      </section>
    ))}
  </main>,
);
