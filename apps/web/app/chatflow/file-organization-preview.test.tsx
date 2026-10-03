import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ChangesetDocument } from '@allrice/contracts';
import { FileOrganizationPreview } from './artifact-workbench';

vi.mock('./cline-adapter/tool-file-diff', () => ({
  ToolFileDiff: () => <div />,
}));

describe('binary file review', () => {
  it('shows the source, target and exact version without treating the binary as text deletion', () => {
    const checksum = `sha256:${'a'.repeat(64)}`,
      version = `sha256:${'b'.repeat(64)}`;
    const document = {
      files: [
        {
          path: '<report>.xlsx',
          before: null,
          after: null,
          organization: {
            path: '<report>.xlsx',
            target: '整理后.xlsx',
            operation: 'move',
            source: { checksum, version, sizeBytes: 100 },
            expectedDestination: null,
          },
        },
      ],
    } as ChangesetDocument;
    const html = renderToStaticMarkup(
      <FileOrganizationPreview document={document} />,
    );
    expect(html).toContain('文件整理方案');
    expect(html).toContain('移动');
    expect(html).toContain('&lt;report&gt;.xlsx');
    expect(html).toContain('整理后.xlsx');
    expect(html).toContain(checksum);
    expect(html).toContain(version);
    expect(html).not.toContain('<report>');
    expect(html).not.toContain('Diff');
    expect(html).not.toContain('<button');
  });
});
