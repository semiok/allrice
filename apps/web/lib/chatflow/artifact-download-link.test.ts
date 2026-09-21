import { describe, expect, it } from 'vitest';
import { artifactDownloadLink } from './artifact-download-link';
const id = '8e11d67c-6718-42c9-99f2-de4530771fdd';
const path = `/api/v1/files/${id}/download`;
const artifacts = [
  { object: { id }, version: { fileName: '报告 & evidence.md' } },
];
describe('verified Artifact links, not model-invented download hosts', () => {
  it.each([
    path,
    `https://allrice.example${path}`,
    `https://invented.invalid${path}?name=wrong&redirect=https://evil.example#fake`,
  ])('resolves a known current-Run file: %s', (href) => {
    expect(artifactDownloadLink(href, artifacts)).toBe(
      `${path}?name=${encodeURIComponent(artifacts[0]!.version.fileName)}`,
    );
  });
  it.each([
    'https://investor.example/annual-report',
    '/api/v1/auth/logout',
    `/api/v1/files/00000000-0000-4000-8000-000000000001/download`,
    `https://user:secret@invented.invalid${path}`,
    `javascript:alert(1)`,
    `https://allrice.example${path}/different`,
    undefined,
  ])('does not convert unrelated, unverified or non-HTTP links: %s', (href) => {
    expect(artifactDownloadLink(href, artifacts)).toBe(href);
  });
  it('does not infer an artifact from a UUID alone', () => {
    const href = `https://allrice.example${path}`;
    expect(artifactDownloadLink(href, [])).toBe(href);
  });
});
