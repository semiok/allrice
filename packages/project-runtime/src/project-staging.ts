import type { ProjectRuntimeCommand } from './types.js';
import type { ProjectSourceFile } from './project-preparation.js';
import { createLocalPythonArchive } from './local-python-archive.js';
import { createHash } from 'node:crypto';
import { projectPreparationLimits } from '@allrice/contracts';

export const projectStagingChunkBytes = 20_000_000;

/** One bounded binary staging layout for both backends; no source bytes in stdin JSON. */
export function projectStagingArchives(input: {
  command: ProjectRuntimeCommand;
  files: ProjectSourceFile[];
  tool: { path: string; bytes: Buffer };
  prepared: { files: { path: string; bytes: Buffer }[] };
  deadlineUnixMs: number;
  deadlineReason: 'timeout' | 'lease_lost';
}) {
  const a = input.command.arguments;
  const chunks: { path: string; bytes: Buffer }[] = [];
  const assemblies: {
    path: string;
    size: number;
    checksum: string;
    parts: string[];
  }[] = [];
  const prepared = input.prepared.files.flatMap((file, index) => {
    if (file.bytes.length <= projectStagingChunkBytes) return [file];
    if (
      !/^\.allrice\/archives\/[A-Za-z0-9._+-]+$/.test(file.path) ||
      file.bytes.length >
        projectPreparationLimits(a.projectPreparation!).archiveBytes
    )
      throw Error('PROJECT_DEPENDENCY_LIMIT');
    const parts: string[] = [];
    for (
      let start = 0;
      start < file.bytes.length;
      start += projectStagingChunkBytes
    ) {
      const path = `.allrice/staging/${index}-${parts.length}.part`;
      parts.push(path);
      chunks.push({
        path,
        bytes: file.bytes.subarray(start, start + projectStagingChunkBytes),
      });
    }
    assemblies.push({
      path: file.path,
      size: file.bytes.length,
      checksum: createHash('sha256').update(file.bytes).digest('hex'),
      parts,
    });
    return [];
  });
  const staged = [
    {
      path: '.allrice/config.json',
      bytes: Buffer.from(
        JSON.stringify({
          command: {
            ...a,
            projectSource: undefined,
            files: [...a.files].sort((f, g) => f.path.localeCompare(g.path)),
          },
          deadlineUnixMs: input.deadlineUnixMs,
          deadlineReason: input.deadlineReason,
          assemblies,
        }),
      ),
    },
    { path: '.allrice/empty.conf', bytes: Buffer.alloc(0) },
    input.tool,
    ...prepared,
    ...chunks,
    ...input.files.map((f) => ({
      path: 'project/' + f.path,
      bytes: Buffer.from(f.content, 'base64'),
    })),
  ];
  const archives: Buffer[] = [];
  let batch: typeof staged = [],
    size = 0;
  for (const f of staged) {
    if (size + f.bytes.length + 2048 > 23_000_000 && batch.length) {
      archives.push(
        createLocalPythonArchive(batch.map((f) => ({ ...f, mode: 0o444 }))),
      );
      batch = [];
      size = 0;
    }
    batch.push(f);
    size += f.bytes.length + 2048;
  }
  if (batch.length)
    archives.push(
      createLocalPythonArchive(batch.map((f) => ({ ...f, mode: 0o444 }))),
    );
  return archives;
}
