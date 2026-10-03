import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  RuntimeChangesetSchema,
  type ChangesetFileResult,
} from '@allrice/contracts';
import { executeFileOrganization } from './file-organization.js';
import { FileGuardianError } from './file-guardian.js';
import { initialChangesetResults } from './changeset-executor.js';
const checksum = `sha256:${'a'.repeat(64)}`,
  version = `sha256:${'b'.repeat(64)}`;
const item = (path: string, target: string) => ({
  path,
  target,
  operation: 'move',
  source: { checksum, version, sizeBytes: 100 },
  expectedDestination: null,
});
const payload = () =>
  RuntimeChangesetSchema.parse({
    capability: 'local.fs.changeset',
    arguments: {
      path: '.',
      artifactId: randomUUID(),
      checksum,
      direction: 'apply',
      comparisonScope: 'file_organization',
      files: [item('a.xlsx', 'new-a.xlsx'), item('b.xlsx', 'new-b.xlsx')].map(
        (organization) => ({
          path: organization.path,
          before: null,
          after: null,
          organization,
        }),
      ),
    },
  });
const survey = (path: string, changed = false) => ({
  files: [
    {
      path,
      checksum,
      version: changed ? `sha256:${'c'.repeat(64)}` : version,
      sizeBytes: 100,
      modifiedAt: '2026-10-03T00:00:00Z',
    },
  ],
  scannedEntries: 1,
  hashBytes: 100,
  skipped: [],
  complete: true,
  truncated: false,
});
describe('binary plan execution over the existing prepared journal', () => {
  it('checks every source before starting any mutation', async () => {
    const p = payload();
    const invoke = vi.fn(async (r: Record<string, unknown>) =>
      survey(String(r.path), r.path === 'b.xlsx'),
    );
    const result = await executeFileOrganization(
      '/owned',
      p,
      { authorize: async () => true, checkpoint: async () => {} },
      initialChangesetResults(p),
      invoke,
    );
    expect(invoke.mock.calls.every(([r]) => r.mode === 'survey')).toBe(true);
    expect(result.files.map((f) => f.status)).toEqual(['pending', 'conflict']);
  });
  it('preserves the confirmed first move and the uncertain second commit without replay', async () => {
    const p = payload(),
      seen: ChangesetFileResult[] = [];
    const invoke = vi.fn(async (r: Record<string, unknown>) => {
      if (r.mode === 'survey') return survey(String(r.path));
      if (r.path === 'b.xlsx')
        throw new FileGuardianError('SOURCE_CHANGED_AFTER_COMMIT', true, {
          path: r.path,
          target: r.target,
          status: 'unknown',
          stage: 'destination_committed',
          sourceRemoved: false,
          error: { code: 'SOURCE_CHANGED_AFTER_COMMIT' },
          recovery: { path: r.target },
        });
      return {
        path: r.path,
        target: r.target,
        status: 'moved',
        file: { checksum, sizeBytes: 100, version: `sha256:${'d'.repeat(64)}` },
        sourceRemoved: true,
        recovery: { path: r.target, checksum },
      };
    });
    const result = await executeFileOrganization(
      '/owned',
      p,
      {
        authorize: async () => true,
        checkpoint: async (_, r) => {
          seen.push(r);
        },
      },
      initialChangesetResults(p),
      invoke,
    );
    expect(result.files.map((f) => f.status)).toEqual(['applied', 'unknown']);
    expect(seen.map((f) => f.status)).toEqual([
      'prepared',
      'applied',
      'prepared',
      'unknown',
    ]);
    expect(result.files[1]?.organization).toMatchObject({
      stage: 'destination_committed',
      recovery: { path: 'new-b.xlsx' },
    });
    expect(invoke.mock.calls.filter(([r]) => r.mode === 'move')).toHaveLength(
      2,
    );
  });
  it('a lost current authority starts no file mutation', async () => {
    const p = payload();
    const invoke = vi.fn(async (r: Record<string, unknown>) =>
      survey(String(r.path)),
    );
    const result = await executeFileOrganization(
      '/owned',
      p,
      { authorize: async () => false, checkpoint: async () => {} },
      initialChangesetResults(p),
      invoke,
    );
    expect(result.files[0]?.status).toBe('canceled');
    expect(invoke.mock.calls.every(([r]) => r.mode === 'survey')).toBe(true);
  });
});
