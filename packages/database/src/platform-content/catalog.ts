import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import {
  allRiceToolManifest,
  SkillResourcePathSchema,
  type SkillBundle,
} from '@allrice/contracts';
import { validateSkillBundle } from '../skill-bundles.ts';

const SkillNameSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const ToolReferenceSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);

const PlatformSkillCatalogEntrySchema = z.object({
  id: z.uuid(),
  name: SkillNameSchema,
  contentFile: z.string().regex(/^skills\/[a-z0-9-]+\/SKILL\.md$/),
  bundleFile: z
    .string()
    .regex(/^skills\/[a-z0-9-]+\/bundle\.json$/)
    .optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  source: z.enum(['allrice', 'dsh-migrated']),
  sourceRef: z.url(),
  license: z.string().min(1),
  reviewStatus: z.literal('reviewed'),
  reviewedByLabel: z.string().min(1),
  createdByLabel: z.string().min(1),
  modelInvocable: z.boolean(),
  userInvocable: z.boolean(),
  requiredToolRefs: z.array(ToolReferenceSchema),
  enabled: z.boolean(),
  replaces: z.array(z.uuid()).max(64).optional(),
});

const PlatformSkillCatalogSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  skills: z.array(PlatformSkillCatalogEntrySchema).min(1),
});

const canonicalToolNames: ReadonlySet<string> = new Set(
  allRiceToolManifest.map((tool) => tool.canonicalName),
);

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

export type PlatformSkillCatalogEntry = z.infer<
  typeof PlatformSkillCatalogEntrySchema
>;

export type ResolvedPlatformSkill = PlatformSkillCatalogEntry & {
  description: string;
  content: string;
  bundle?: SkillBundle;
};

export type PlatformContentCatalog = {
  schemaVersion: 1 | 2;
  catalogChecksum: string;
  skills: ResolvedPlatformSkill[];
};

function sha256(value: string) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function parseSkillMarkdown(rawInput: string, sourceLabel: string) {
  const raw = rawInput.replaceAll('\r\n', '\n');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) {
    throw new Error(`platform_skill_frontmatter_invalid:${sourceLabel}`);
  }

  const fields = new Map<string, string>();
  for (const line of match[1]!.split('\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      throw new Error(`platform_skill_frontmatter_invalid:${sourceLabel}`);
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key || !value || fields.has(key)) {
      throw new Error(`platform_skill_frontmatter_invalid:${sourceLabel}`);
    }
    fields.set(key, value);
  }

  const name = fields.get('name');
  const description = fields.get('description');
  if (!name || !description || fields.size !== 2) {
    throw new Error(`platform_skill_frontmatter_invalid:${sourceLabel}`);
  }

  // Skill source files may have harmless blank lines around the Markdown body.
  // The database representation is canonical: no leading blank line and
  // exactly one trailing newline. Historical migrations use the same form.
  const content = `${match[2]!.trim()}\n`;
  if (Buffer.byteLength(content, 'utf8') > 500_000) {
    throw new Error(`platform_skill_content_too_large:${sourceLabel}`);
  }

  return {
    name: SkillNameSchema.parse(name),
    description,
    content,
    checksum: sha256(content),
  };
}

export async function parsePlatformContentCatalog(
  input: unknown,
  readSkill: (contentFile: string) => Promise<string>,
  readResource?: (path: string) => Promise<Uint8Array>,
): Promise<PlatformContentCatalog> {
  const catalog = PlatformSkillCatalogSchema.parse(input);
  const replacementOwners = new Set<string>();
  for (const entry of catalog.skills) {
    for (const previousId of entry.replaces ?? []) {
      const previous = catalog.skills.find((skill) => skill.id === previousId);
      if (
        !entry.enabled ||
        !previous ||
        previous.enabled ||
        previousId === entry.id ||
        replacementOwners.has(previousId)
      ) {
        throw new Error(
          `platform_skill_catalog_invalid_replacement:${entry.name}:${previousId}`,
        );
      }
      replacementOwners.add(previousId);
    }
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  const skills: ResolvedPlatformSkill[] = [];

  for (const entry of catalog.skills) {
    if (ids.has(entry.id)) {
      throw new Error(`platform_skill_catalog_duplicate_id:${entry.id}`);
    }
    if (names.has(entry.name)) {
      throw new Error(`platform_skill_catalog_duplicate_name:${entry.name}`);
    }
    if (entry.contentFile !== `skills/${entry.name}/SKILL.md`) {
      throw new Error(`platform_skill_catalog_path_mismatch:${entry.name}`);
    }
    if (
      entry.bundleFile &&
      (catalog.schemaVersion !== 2 ||
        entry.bundleFile !== `skills/${entry.name}/bundle.json`)
    )
      throw Error('platform_skill_bundle_path_mismatch');
    if (
      new Set(entry.requiredToolRefs).size !== entry.requiredToolRefs.length
    ) {
      throw new Error(`platform_skill_catalog_duplicate_tool:${entry.name}`);
    }
    for (const toolRef of entry.requiredToolRefs) {
      if (!canonicalToolNames.has(toolRef)) {
        throw new Error(
          `platform_skill_catalog_unknown_tool:${entry.name}:${toolRef}`,
        );
      }
    }

    const source = parseSkillMarkdown(
      await readSkill(entry.contentFile),
      entry.contentFile,
    );
    if (source.name !== entry.name) {
      throw new Error(`platform_skill_catalog_name_mismatch:${entry.name}`);
    }
    if (source.checksum !== entry.checksum) {
      throw new Error(`platform_skill_catalog_checksum_mismatch:${entry.name}`);
    }
    const sourceRef = new URL(entry.sourceRef);
    const sourceDigest = sourceRef.searchParams.get('content-sha256');
    if (`sha256:${sourceDigest ?? ''}` !== entry.checksum) {
      throw new Error(
        `platform_skill_catalog_source_ref_not_content_addressed:${entry.name}`,
      );
    }

    let bundle: SkillBundle | undefined;
    if (entry.bundleFile) {
      const manifest = JSON.parse(await readSkill(entry.bundleFile));
      if (!Array.isArray(manifest.resources) || manifest.resources.length > 32)
        throw Error('platform_skill_bundle_resources_invalid');
      const resources = [];
      for (const resource of manifest.resources) {
        const path = SkillResourcePathSchema.parse(resource.path);
        if ('contentBase64' in resource)
          throw Error('platform_skill_bundle_embedded_content');
        const file = `skills/${entry.name}/${path}`;
        const bytes = readResource
          ? await readResource(file)
          : Buffer.from(await readSkill(file));
        resources.push({
          ...resource,
          contentBase64: Buffer.from(bytes).toString('base64'),
        });
      }
      bundle = validateSkillBundle({ ...manifest, resources }, source.content);
      if (
        bundle.version !== entry.version ||
        bundle.license !== entry.license ||
        bundle.sourceRef !== entry.sourceRef ||
        bundle.reviewedBy !== entry.reviewedByLabel
      )
        throw Error('platform_skill_bundle_governance_mismatch');
      if (
        bundle.dependencies.some(
          (d) => d.kind === 'tool' && !entry.requiredToolRefs.includes(d.name),
        )
      )
        throw Error('platform_skill_bundle_undeclared_tool');
    }
    ids.add(entry.id);
    names.add(entry.name);
    skills.push({
      ...entry,
      description: source.description,
      content: source.content,
      ...(bundle ? { bundle } : {}),
    });
  }

  return {
    schemaVersion: catalog.schemaVersion,
    catalogChecksum: sha256(JSON.stringify(catalog)),
    skills,
  };
}

export async function loadPlatformContentCatalog(
  rootDirectory = repositoryRoot,
): Promise<PlatformContentCatalog> {
  const canonicalRoot = await realpath(rootDirectory);
  const directory = resolve(canonicalRoot, 'skills');
  if ((await lstat(directory)).isSymbolicLink())
    throw Error('platform_skill_resource_symlink');
  const skillsRoot = `${directory}${sep}`;

  const readAsset = async (contentFile: string) => {
    const absolutePath = resolve(canonicalRoot, contentFile);
    if (!absolutePath.startsWith(skillsRoot)) {
      throw new Error(`platform_skill_catalog_path_escaped:${contentFile}`);
    }
    let current = skillsRoot.slice(0, -1);
    for (const part of absolutePath.slice(skillsRoot.length).split(sep)) {
      current = resolve(current, part);
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw Error('platform_skill_resource_symlink');
    }
    // Reject special files before opening: O_RDONLY can otherwise block forever
    // on a FIFO. Recheck the opened descriptor to close the leaf replacement race.
    const expected = await lstat(absolutePath);
    if (!expected.isFile() || expected.nlink !== 1 || expected.size > 900000)
      throw Error('platform_skill_resource_unsafe');
    const handle = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > 900000 ||
        stat.dev !== expected.dev ||
        stat.ino !== expected.ino
      )
        throw Error('platform_skill_resource_unsafe');
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  };
  const input = JSON.parse(
    (await readAsset('skills/catalog.json')).toString('utf8'),
  ) as unknown;
  return parsePlatformContentCatalog(
    input,
    async (file) => (await readAsset(file)).toString('utf8'),
    readAsset,
  );
}
