import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { acceptedRepositoryFixture } from './platform-repository-publication.fixture.ts';
import { freezeRepositoryPublicationSource } from './platform-repository-publication-source.ts';
describe('frozen accepted candidate publication', () => {
  const source = () => ({
    id: randomUUID(),
    run_id: randomUUID(),
    job_id: randomUUID(),
    status: 'succeeded',
    ...acceptedRepositoryFixture(randomUUID(), new Date().toISOString()),
  });
  it('keeps the exact before/after bytes and refuses a stale release or forged completed status', () => {
    const row = source(),
      sha = row.frozen.releaseSha;
    expect(freezeRepositoryPublicationSource(row, sha)).toMatchObject({
      repairTaskId: row.id,
      afterBase64: row.candidate.files[0]!.afterBase64,
    });
    expect(() =>
      freezeRepositoryPublicationSource(row, 'b'.repeat(40)),
    ).toThrow('REPOSITORY_SOURCE_NOT_ACCEPTED');
    expect(() =>
      freezeRepositoryPublicationSource({ ...row, status: 'running' }, sha),
    ).toThrow('REPOSITORY_SOURCE_NOT_ACCEPTED');
    row.report.after.report.harnessChecksum = 'sha256:' + 'f'.repeat(64);
    expect(() => freezeRepositoryPublicationSource(row, sha)).toThrow(
      'REPOSITORY_SOURCE_NOT_ACCEPTED',
    );
  });
  it('refuses modified candidate bytes even when a report still claims success', () => {
    const row = source();
    row.candidate.files[0]!.afterBase64 =
      Buffer.from('foreign source').toString('base64');
    expect(() =>
      freezeRepositoryPublicationSource(row, row.frozen.releaseSha),
    ).toThrow();
  });
});
