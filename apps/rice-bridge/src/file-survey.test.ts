import { describe, expect, it } from 'vitest';
import { LocalFileSurveyInputSchema } from '@allrice/contracts';
import { NativeFileSurveySchema, projectFileSurvey } from './file-survey.js';
const checksum = `sha256:${'a'.repeat(64)}`;
const file = (path: string, hash = checksum) => ({
  path,
  sizeBytes: 100,
  modifiedAt: '2026-10-03T00:00:00.000Z',
  ...(hash ? { checksum: hash } : {}),
});
const scan = (files: ReturnType<typeof file>[], complete = true) =>
  NativeFileSurveySchema.parse({
    files,
    scannedEntries: files.length,
    hashBytes: files.length * 100,
    skipped: [],
    truncated: !complete,
    complete,
  });
describe('bounded directory findings', () => {
  it('finds equal content under different names and never treats equal names as equal bytes', () => {
    const result = projectFileSurvey(
      scan([
        file('left/first.xlsx'),
        file('left/second.xlsx'),
        file('left/other.xlsx', `sha256:${'b'.repeat(64)}`),
      ]),
      null,
      'left',
      LocalFileSurveyInputSchema.parse({ mode: 'duplicates', hash: true }),
    );
    expect('groups' in result && result.groups).toEqual([
      { checksum, paths: ['left/first.xlsx', 'left/second.xlsx'] },
    ]);
    expect('deletionPerformed' in result && result.deletionPerformed).toBe(
      false,
    );
  });
  it('preserves uncertainty when hashes are absent or one directory was truncated', () => {
    const result = projectFileSurvey(
      scan([file('left/a', ''), file('left/b')]),
      scan([file('right/a', '')], false),
      'left',
      LocalFileSurveyInputSchema.parse({
        mode: 'compare',
        comparePath: 'right',
      }),
    );
    expect(
      'differences' in result && result.differences.map((x) => x.status),
    ).toEqual(['unknown', 'unknown']);
    expect(result.complete).toBe(false);
  });
  it('filters by name, extension, size and modification time together', () => {
    const result = projectFileSurvey(
      scan([
        file('left/日报.xlsx'),
        file('left/日报.csv'),
        file('left/月报.xlsx'),
      ]),
      null,
      'left',
      LocalFileSurveyInputSchema.parse({
        mode: 'files',
        nameContains: '日报',
        extensions: ['xlsx'],
        minimumBytes: 99,
        maximumBytes: 101,
        modifiedAfter: '2026-10-02T00:00:00Z',
        modifiedBefore: '2026-10-04T00:00:00Z',
      }),
    );
    expect(result.files.map((x) => x.path)).toEqual(['left/日报.xlsx']);
  });
});
