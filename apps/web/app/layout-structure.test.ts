import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const layoutSource = readFileSync(
  new URL('./layout.tsx', import.meta.url),
  'utf8',
);
const sharedStyles = readFileSync(
  new URL('../../../packages/ui/src/styles.css', import.meta.url),
  'utf8',
);
const chatFlowStyles = readFileSync(
  new URL('./chatflow/dsh-saas.module.css', import.meta.url),
  'utf8',
);

describe('root layout structure', () => {
  it('mounts the active page directly without the retired AppShell', () => {
    expect(layoutSource).toContain('<body>{children}</body>');
    expect(layoutSource).not.toMatch(/AppShell|app-shell/);
  });

  it('keeps the global stylesheet cascade explicit and stable', () => {
    const expectedImports = [
      "import './dsh-upstream/design-platform.css';",
      "import './dsh-upstream/base.css';",
      "import './dsh-upstream/scrollbar.css';",
      "import './styles/base.css';",
      "import './styles/auth.css';",
      "import '@allrice/ui/styles.css';",
    ];

    const positions = expectedImports.map((statement) =>
      layoutSource.indexOf(statement),
    );

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(
      [...positions].sort((left, right) => left - right),
    );
  });

  it('does not retain selectors for deleted shell surfaces', () => {
    expect(sharedStyles).not.toMatch(
      /\.app-shell|\.app-sidebar|\.employee-panel-only|\.automation-shell|\.automation-main|\.automation-context/,
    );
  });

  it('pins the ChatFlow shell to the dynamic viewport', () => {
    expect(chatFlowStyles).toMatch(
      /main\.shell\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;[^}]*height:\s*100dvh;[^}]*max-height:\s*100dvh;[^}]*overflow:\s*hidden;/s,
    );
  });
});
