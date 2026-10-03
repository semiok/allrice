import { posix } from 'node:path';
import { z } from 'zod';
import {
  LocalFileSurveyInputSchema,
  type LocalFileSurveyInput,
} from '@allrice/contracts';
import {
  invokeFileGuardian,
  type FileGuardianControls,
} from './file-guardian.js';

const entry = z
  .object({
    path: z.string().max(1024),
    sizeBytes: z.number().int().nonnegative(),
    modifiedAt: z.iso.datetime(),
    checksum: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    version: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export const NativeFileSurveySchema = z
  .object({
    files: z.array(entry).max(2000),
    scannedEntries: z.number().int().nonnegative(),
    hashBytes: z.number().int().nonnegative(),
    skipped: z
      .array(
        z
          .object({ path: z.string().max(1024), reason: z.string().max(80) })
          .strict(),
      )
      .max(2000),
    truncated: z.boolean(),
    complete: z.boolean(),
  })
  .strict();
type Survey = z.infer<typeof NativeFileSurveySchema>;

function filtered(files: Survey['files'], input: LocalFileSurveyInput) {
  return files.filter((f) => {
    const name = posix.basename(f.path).toLocaleLowerCase();
    return (
      (!input.nameContains ||
        name.includes(input.nameContains.toLocaleLowerCase())) &&
      (!input.extensions?.length ||
        input.extensions.some(
          (e) => '.' + e.toLowerCase() === posix.extname(name),
        )) &&
      (input.minimumBytes === undefined || f.sizeBytes >= input.minimumBytes) &&
      (input.maximumBytes === undefined || f.sizeBytes <= input.maximumBytes) &&
      (!input.modifiedAfter ||
        Date.parse(f.modifiedAt) >= Date.parse(input.modifiedAfter)) &&
      (!input.modifiedBefore ||
        Date.parse(f.modifiedAt) <= Date.parse(input.modifiedBefore))
    );
  });
}

/** Findings retain unknown/truncated state. A missing hash never proves equality. */
export function projectFileSurvey(
  left: Survey,
  right: Survey | null,
  path: string,
  input: LocalFileSurveyInput,
) {
  const files = filtered(left.files, input);
  const common = {
    mode: input.mode,
    path,
    files,
    scannedEntries: left.scannedEntries + (right?.scannedEntries ?? 0),
    hashBytes: left.hashBytes + (right?.hashBytes ?? 0),
    skipped: left.skipped,
    truncated: left.truncated || (right?.truncated ?? false),
    complete: left.complete && (right?.complete ?? true),
  };
  if (input.mode === 'duplicates') {
    const groups = new Map<string, string[]>();
    for (const file of files)
      if (file.checksum) {
        const key = file.sizeBytes + ':' + file.checksum;
        groups.set(key, [...(groups.get(key) ?? []), file.path]);
      }
    return {
      ...common,
      complete: common.complete && files.every((file) => !!file.checksum),
      unverifiedFiles: files.filter((file) => !file.checksum).length,
      groups: [...groups]
        .filter(([, paths]) => paths.length > 1)
        .map(([key, paths]) => ({
          checksum: key.slice(key.indexOf(':') + 1),
          paths,
        })),
      deletionPerformed: false,
    };
  }
  if (input.mode === 'compare' && right) {
    const leftFiles = new Map(
      files.map((f) => [posix.relative(path, f.path), f]),
    );
    const rightFiles = new Map(
      filtered(right.files, input).map((f) => [
        posix.relative(input.comparePath!, f.path),
        f,
      ]),
    );
    const differences = [
      ...new Set([...leftFiles.keys(), ...rightFiles.keys()]),
    ]
      .sort()
      .map((name) => {
        const a = leftFiles.get(name),
          b = rightFiles.get(name);
        const status = !a
          ? left.complete
            ? 'right_only'
            : 'unknown'
          : !b
            ? right.complete
              ? 'left_only'
              : 'unknown'
            : !a.checksum || !b.checksum
              ? 'unknown'
              : a.sizeBytes === b.sizeBytes && a.checksum === b.checksum
                ? 'same'
                : 'different';
        return { path: name, status, left: a ?? null, right: b ?? null };
      });
    return {
      ...common,
      comparePath: input.comparePath,
      skipped: [...left.skipped, ...right.skipped],
      differences,
    };
  }
  return common;
}

export async function executeFileSurvey(
  root: string,
  path: string,
  raw: unknown,
  controls: FileGuardianControls = {},
  invoke = invokeFileGuardian,
) {
  const input = LocalFileSurveyInputSchema.parse(raw);
  const scan = async (
    directory: string,
    maximumEntries: number,
    maximumHashBytes: number,
  ) =>
    NativeFileSurveySchema.parse(
      await invoke(
        {
          mode: 'survey',
          root,
          path: directory,
          maximumEntries,
          maximumHashBytes,
          hash: input.hash || input.mode !== 'files',
        },
        controls,
      ),
    );
  const paired = input.mode === 'compare';
  const left = await scan(
    path,
    paired ? Math.floor(input.maximumEntries / 2) : input.maximumEntries,
    paired ? Math.floor(input.maximumHashBytes / 2) : input.maximumHashBytes,
  );
  const right = paired
    ? await scan(
        input.comparePath!,
        Math.ceil(input.maximumEntries / 2),
        Math.ceil(input.maximumHashBytes / 2),
      )
    : null;
  let output = projectFileSurvey(left, right, path, input);
  // Bound the durable receipt as well as native I/O; keep exclusions explicit.
  if (Buffer.byteLength(JSON.stringify(output)) > 160_000) {
    const original = output.files.length;
    output = { ...output, files: [], truncated: true, complete: false };
    if ('groups' in output)
      output = { ...output, groups: output.groups.slice(0, 80) };
    if ('differences' in output)
      output = { ...output, differences: output.differences.slice(0, 80) };
    if (Buffer.byteLength(JSON.stringify(output)) > 160_000)
      throw Error('FILE_SURVEY_RESULT_LIMIT');
    return {
      output: { ...output, omittedFiles: original },
      summary: '目录调查已达到输出上限；请缩小目录或筛选范围，未执行任何删除',
    };
  }
  return {
    output,
    summary: `已调查 ${output.scannedEntries} 个目录项${output.complete ? '' : '，存在跳过或未完成项'}；未修改文件`,
  };
}
