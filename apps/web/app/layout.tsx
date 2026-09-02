import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './dsh-upstream/design-platform.css';
import './dsh-upstream/base.css';
import './dsh-upstream/scrollbar.css';
import './styles/base.css';
import './styles/auth.css';
import '@allrice/ui/styles.css';

import { readFrameworkRolloutPolicy } from '../lib/framework/rollout';

const thirdPartyErrorGuard = `
(() => {
  const isExternalBrowserError = (value) => {
    if (!value) return false;
    const text = typeof value === 'string'
      ? value
      : [value.message, value.stack, value.filename].filter(Boolean).join(' ');
    return text.includes('chrome-extension://')
      || text.includes('func sseError not found')
      || text.includes('Access to storage is not allowed from this context');
  };

  const stopExternalError = (event) => {
    if (!isExternalBrowserError(event.error || event.message || event.reason)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  window.addEventListener('error', stopExternalError, true);
  window.addEventListener('unhandledrejection', stopExternalError, true);
})();
`;

export const metadata: Metadata = {
  title: 'AllRice',
  description: 'AI workspace for enterprise employees',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const policy = readFrameworkRolloutPolicy();
  const framework =
    policy.emergencyOff || !policy.defaultEnabled ? 'legacy' : 'v2';
  return (
    <html data-allrice-framework={framework} lang="zh-CN">
      <head>
        <script dangerouslySetInnerHTML={{ __html: thirdPartyErrorGuard }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
