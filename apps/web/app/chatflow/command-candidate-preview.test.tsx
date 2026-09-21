import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CommandCandidatePreview } from './command-candidate-preview';
import {
  candidateCommand,
  change,
} from '../../../rice-bridge/test/command-candidate.fixture';

vi.mock('./cline-adapter/tool-file-diff', () => ({
  ToolFileDiff: () => <div data-testid="existing-cline-diff" />,
}));
describe('candidate approval preview (presentation only)', () => {
  const candidate = candidateCommand([
    change(
      'test.mjs',
      'throw Error("old source");',
      '<script>not executable HTML</script>',
    ),
  ]).arguments.candidate!;
  it('shows exact version, existing Diff and escaped source with the no-host-write boundary', () => {
    const html = renderToStaticMarkup(
      <CommandCandidatePreview candidate={candidate} state="current" />,
    );
    expect(html).toContain(candidate.artifactId);
    expect(html).toContain(candidate.checksum);
    expect(html).toContain('existing-cline-diff');
    expect(html).toContain('不会写回原目录');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
  it.each(['stale', 'unavailable'] as const)(
    'distinguishes %s from a verified current version',
    (state) => {
      const html = renderToStaticMarkup(
        <CommandCandidatePreview candidate={candidate} state={state} />,
      );
      expect(html).toContain(
        state === 'stale' ? '不能证明新版本已通过' : '未确认时不可批准',
      );
    },
  );
  it('does not crash on invalid proposal bytes', () => {
    expect(
      renderToStaticMarkup(
        <CommandCandidatePreview candidate={{ ...candidate, content: '{' }} />,
      ),
    ).toContain('请勿批准');
  });
});
