import type { ReactNode } from 'react';
import { AppearanceScript } from '../../components/theme/appearance-script';

// Signed-in workspace pages paint the employee's saved appearance first.
export default function ChatFlowLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <AppearanceScript />
      {children}
    </>
  );
}
