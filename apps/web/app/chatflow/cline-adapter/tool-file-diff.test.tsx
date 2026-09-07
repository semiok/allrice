import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseBoundedDiff, ToolFileDiff } from './tool-file-diff';
describe('pinned Cline/Pierre adapter', () => {
  it('does not silently add an EOF newline to reviewed bytes', () => {
    const diff = parseBoundedDiff('a.ts', 'const a=1;', 'const a=1;\n');
    expect(diff).not.toBeNull();
    expect(diff!.deletionLines.join('')).toBe('const a=1;');
    expect(diff!.additionLines.join('')).toBe('const a=1;\n');
    expect(diff!.hunks.length).toBeGreaterThan(0);
  });
  it('handles creations, deletions and CRLF without changing the versions', () => {
    expect(
      parseBoundedDiff('a.txt', null, 'a\r\n')!.additionLines.join(''),
    ).toBe('a\r\n');
    expect(parseBoundedDiff('a.txt', 'a', null)!.deletionLines.join('')).toBe(
      'a',
    );
  });
  it('declines long inputs before parsing and presents a visible fallback', () => {
    const after = 'x\n'.repeat(20_000);
    expect(parseBoundedDiff('large.txt', null, after)).toBeNull();
    const html = renderToStaticMarkup(
      <ToolFileDiff
        path="large.txt"
        before={null}
        after={after}
        mode="unified"
        onSelect={() => {}}
      />,
    );
    expect(html).toContain('文件过长');
    expect(html).not.toContain('diffs-container');
  });
});
