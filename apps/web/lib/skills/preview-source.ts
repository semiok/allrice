import {
  personalSkillLimits,
  SkillPackageSourceSchema,
  type PersonalSkillPreviewRequest,
} from '@allrice/contracts';
import { skillBytesChecksum } from '@allrice/database';
import { createFileArchive, readFileArchive } from '@allrice/file-archives';
import {
  readPublicGitHubSource,
  SkillPreviewError,
} from '@allrice/skill-import';

/** Both import kinds use the same bounded, credential-free source reader.
 * The caller must authorize before fetching and after parsing. */
export async function readSkillPreviewSource(
  input: PersonalSkillPreviewRequest['source'],
  archive?: Uint8Array,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  let bytes: Uint8Array;
  let files;
  let github;
  if (input.kind === 'github') {
    if (archive !== undefined) throw new SkillPreviewError('source_invalid');
    github = await readPublicGitHubSource(input.url, {
      signal,
      rootOnly: true,
    });
    files = github.files;
    bytes = await createFileArchive(files, {
      signal,
      maximumFiles: personalSkillLimits.packageResources + 1,
    });
  } else {
    if (!archive || archive.byteLength > personalSkillLimits.archiveBytes)
      throw new SkillPreviewError('source_invalid');
    bytes = Buffer.from(archive);
    const timeout = AbortSignal.timeout(15_000);
    files = await readFileArchive(bytes, {
      maximumFiles: personalSkillLimits.packageResources + 1,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  }
  if (bytes.byteLength > personalSkillLimits.archiveBytes)
    throw new SkillPreviewError('source_invalid');
  const digest = skillBytesChecksum(bytes);
  const source = SkillPackageSourceSchema.parse(
    github
      ? {
          kind: 'github',
          ...github.provenance,
          fileName: `${github.provenance.repository}.zip`,
          originalChecksum: digest,
          byteLength: bytes.byteLength,
          candidatePath: 'SKILL.md',
        }
      : {
          kind: 'zip',
          fileName: input.kind === 'zip' ? input.fileName : '',
          originalChecksum: digest,
          byteLength: bytes.byteLength,
        },
  );
  return { bytes, files, source };
}
