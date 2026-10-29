import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkbenchArtifact } from '@allrice/contracts';
import { ChangesetPanel } from './changeset-panel';
describe('isolated proposal application boundary', () => {
  it('shows an explicit proposal-only notice, not a misleading apply button', () => {
    const artifact = {
      id: 'synthetic',
      execution: { workCopy: { kind: 'local_copy' } },
    } as WorkbenchArtifact;
    const html = renderToStaticMarkup(
      <ChangesetPanel
        artifact={artifact}
        sessionId="session"
        workspaceId="workspace"
        headers={{}}
        disabled={false}
      />,
    );
    expect(html).toContain('隔离副本中的修改提案 · 还没保存到电脑');
    expect(html).toContain('不能直接保存到原来的文件夹');
    expect(html).not.toContain('<button');
  });
});
