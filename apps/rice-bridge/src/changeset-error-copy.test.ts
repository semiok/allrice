// The words employees read for a file the Bridge did not change, checked
// against codes these write checks really raise. Copy lives in the web
// presenter (apps/web/lib/chatflow/changeset-presenter.ts).
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changesetFileNote } from '../../web/lib/chatflow/changeset-presenter.ts';
import { checkChangesetFile, writeTextFile } from './executor.js';

const engineering = /[A-Z]+_[A-Z]+|核实|落盘|Bridge|失败/;

describe('changeset file notes for codes the Bridge raises', () => {
  it('explains the codes the write checks actually raise', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'changeset-')));
    try {
      await writeFile(join(root, 'exists.txt'), 'kept');
      await writeFile(join(root, 'plain.txt'), 'kept');
      const code = async (attempt: Promise<unknown>) => {
        try {
          await attempt;
        } catch (error) {
          return (error as { code?: string }).code;
        }
        throw Error('expected the Bridge to refuse');
      };
      const digest = `sha256:${'0'.repeat(64)}`;
      const samples = {
        // A new file whose path is already taken: WRITE_CONFLICT, the same
        // code as a file edited after review, so the words stay neutral.
        planned: await code(checkChangesetFile(root, 'exists.txt', null)),
        edited: await code(checkChangesetFile(root, 'exists.txt', digest)),
        absent: await code(checkChangesetFile(root, 'gone.txt', digest)),
        overwrite: await code(writeTextFile(root, 'exists.txt', 'x', null)),
        noFolder: await code(writeTextFile(root, 'missing/a.txt', 'x', null)),
        // Not a typed Bridge error: changeset-executor.ts reports it as
        // PREFLIGHT_FAILED.
        throughFile: await code(
          checkChangesetFile(root, 'plain.txt/inner.txt', null),
        ),
      };
      expect(samples).toEqual({
        planned: 'WRITE_CONFLICT',
        edited: 'WRITE_CONFLICT',
        absent: 'WRITE_CONFLICT',
        overwrite: 'WRITE_PRECONDITION_REQUIRED',
        noFolder: 'DIRECTORY_NOT_FOUND',
        throughFile: 'ENOTDIR',
      });
      for (const sample of [samples.planned, samples.edited, samples.absent]) {
        const note = changesetFileNote('conflict', sample);
        expect(note).toContain('保存前的检查没有通过');
        expect(note).not.toMatch(/改动过|同名|找不到/);
      }
      expect(changesetFileNote('conflict', samples.overwrite)).toContain(
        '同名的文件或文件夹',
      );
      expect(changesetFileNote('conflict', samples.noFolder)).toContain(
        '要保存到的文件夹不存在',
      );
      expect(changesetFileNote('conflict', 'PREFLIGHT_FAILED')).toContain(
        '保存前的检查没有通过',
      );
      for (const sample of [...Object.values(samples), 'PREFLIGHT_FAILED'])
        expect(changesetFileNote('conflict', sample)).not.toMatch(engineering);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
