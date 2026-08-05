import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './styles.css';

export const metadata: Metadata = {
  title: 'AllRice',
  description: 'AI workspace for enterprise employees',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
