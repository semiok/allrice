import { posix } from 'node:path';
import {
  SkillResourcePathSchema,
  personalSkillLimits,
} from '@allrice/contracts';
import { PersonalSkillError, skillBytesChecksum } from '@allrice/database';
import { readFileArchive } from '@allrice/file-archives';
import { ZodError } from 'zod';
import { parsePersonalSkill } from './personal-skill-import.js';

// Package resources retain the existing platform bundle's bounds. Their bytes
// will be stored privately, not copied into every execution snapshot.
export const personalSkillPackageLimits = {
  candidates: personalSkillLimits.packageCandidates,
  resources: personalSkillLimits.packageResources,
  resourceBytes: personalSkillLimits.resourceBytes,
  totalResourceBytes: personalSkillLimits.totalResourceBytes,
} as const;

export type PersonalSkillPackageFile = {
  path: string;
  bytes: Uint8Array;
};
type ResourceIssue = {
  code:
    | 'invalid_definition'
    | 'invalid_resource_path'
    | 'resource_limit'
    | 'missing_resource';
  path: string;
};
export type PersonalSkillPackageCandidate = {
  sourcePath: string;
  parsed?: Awaited<ReturnType<typeof parsePersonalSkill>>;
  resources: Array<
    PersonalSkillPackageFile & { byteLength: number; checksum: string }
  >;
  manifestChecksum?: string;
  issues: ResourceIssue[];
};

export async function readPersonalSkillArchive(
  bytes: Uint8Array,
  signal?: AbortSignal,
) {
  const timeout = AbortSignal.timeout(15_000);
  const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const files = await readFileArchive(bytes, { signal: bounded });
  return inspectPersonalSkillPackage(files, bounded);
}

/** This operates on files from the bounded archive reader. It never extracts
 * package paths, executes scripts, selects a candidate or enables a binding. */
export async function inspectPersonalSkillPackage(
  files: readonly PersonalSkillPackageFile[],
  signal?: AbortSignal,
  candidatePaths?: readonly string[],
): Promise<PersonalSkillPackageCandidate[]> {
  signal?.throwIfAborted();
  const names = new Set<string>();
  for (const file of files) {
    // Defence in depth for other future sources, including GitHub. Preserve
    // exact names rather than silently canonicalising traversal or collisions.
    if (
      !file.path ||
      file.path.startsWith('/') ||
      file.path.includes('\\') ||
      file.path.includes(':') ||
      [...file.path].some((character) => {
        const code = character.codePointAt(0)!;
        return (
          code < 0x20 ||
          (code >= 0x7f && code <= 0x9f) ||
          (code >= 0x202a && code <= 0x202e) ||
          (code >= 0x2066 && code <= 0x2069)
        );
      }) ||
      file.path
        .split('/')
        .some((part) => !part || part === '.' || part === '..')
    )
      throw Error('personal_skill_package_unsafe_path');
    const key = file.path.normalize('NFC').toUpperCase().toLowerCase();
    if (names.has(key)) throw Error('personal_skill_package_path_conflict');
    names.add(key);
  }
  if (
    candidatePaths !== undefined &&
    (!Array.isArray(candidatePaths) ||
      !candidatePaths.length ||
      candidatePaths.length > personalSkillPackageLimits.candidates ||
      new Set(candidatePaths).size !== candidatePaths.length)
  )
    throw Error('personal_skill_package_candidate_limit');
  const definitions = files
    .filter(
      (file) =>
        posix.basename(file.path) === 'SKILL.md' &&
        (candidatePaths === undefined || candidatePaths.includes(file.path)),
    )
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (
    candidatePaths !== undefined &&
    definitions.length !== candidatePaths.length
  )
    throw Error('personal_skill_package_missing_skill');
  if (!definitions.length) throw Error('personal_skill_package_missing_skill');
  if (definitions.length > personalSkillPackageLimits.candidates)
    throw Error('personal_skill_package_candidate_limit');
  const candidates: PersonalSkillPackageCandidate[] = [];
  for (const file of definitions) {
    signal?.throwIfAborted();
    const candidate: PersonalSkillPackageCandidate = {
      sourcePath: file.path,
      resources: [],
      issues: [],
    };
    try {
      // Isolate precisely one selected definition for the public native parser;
      // it must not discover repository README files or sibling candidates.
      candidate.parsed = await parsePersonalSkill(file.bytes);
    } catch (error) {
      // Invalid user content is a compatibility result. IO/native failures
      // remain errors, so a full disk cannot masquerade as a bad skill file.
      if (!(error instanceof PersonalSkillError || error instanceof ZodError))
        throw error;
      candidate.issues.push({ code: 'invalid_definition', path: file.path });
    }
    signal?.throwIfAborted();
    const directory = posix.dirname(file.path);
    const prefix = directory === '.' ? '' : directory + '/';
    let bytes = 0;
    for (const entry of files) {
      if (!entry.path.startsWith(prefix)) continue;
      const path = entry.path.slice(prefix.length);
      if (!/^(?:references|assets|scripts)\//u.test(path)) continue;
      if (!SkillResourcePathSchema.safeParse(path).success) {
        candidate.issues.push({ code: 'invalid_resource_path', path });
        continue;
      }
      bytes += entry.bytes.byteLength;
      if (
        candidate.resources.length >= personalSkillPackageLimits.resources ||
        entry.bytes.byteLength > personalSkillPackageLimits.resourceBytes ||
        bytes > personalSkillPackageLimits.totalResourceBytes
      ) {
        candidate.issues.push({ code: 'resource_limit', path });
        continue;
      }
      candidate.resources.push({
        path,
        bytes: entry.bytes,
        byteLength: entry.bytes.byteLength,
        checksum: skillBytesChecksum(entry.bytes),
      });
    }
    candidate.resources.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    if (candidate.parsed) {
      const available = new Set(
        candidate.resources.map((resource) => resource.path),
      );
      // Report explicit literal relative references. This is not a claim to
      // statically verify arbitrary code, dependencies or business behaviour.
      const referenced = new Set(
        Array.from(
          candidate.parsed.definition.content.matchAll(
            /(?<![\w:/])((?:references|assets|scripts)\/[A-Za-z0-9_./-]+)/gu,
          ),
          (match) => match[1]!.replace(/[.]+$/u, ''),
        ),
      );
      for (const path of referenced)
        if (!available.has(path))
          candidate.issues.push({ code: 'missing_resource', path });
      if (!candidate.issues.length)
        candidate.manifestChecksum = skillBytesChecksum(
          JSON.stringify({
            schemaVersion: 1,
            originalChecksum: skillBytesChecksum(file.bytes),
            resources: candidate.resources.map(
              ({ path, byteLength, checksum }) => ({
                path,
                byteLength,
                checksum,
              }),
            ),
          }),
        );
    }
    candidates.push(candidate);
  }
  return candidates;
}
