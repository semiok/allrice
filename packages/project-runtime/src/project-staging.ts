import type { ProjectRuntimeCommand } from './types.js';
import type { ProjectSourceFile } from './project-preparation.js';
import { createLocalPythonArchive } from './local-python-archive.js';

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
        }),
      ),
    },
    { path: '.allrice/empty.conf', bytes: Buffer.alloc(0) },
    input.tool,
    ...input.prepared.files,
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
