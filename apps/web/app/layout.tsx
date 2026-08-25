import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './styles.css';

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
  return (
    <html lang="zh-CN">
      <head>
        <script dangerouslySetInnerHTML={{ __html: thirdPartyErrorGuard }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
