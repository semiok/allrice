import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { allRiceToolManifest } from '@allrice/contracts';

const SkillNameSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const ToolReferenceSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);

const PlatformSkillCatalogEntrySchema = z.object({
  id: z.uuid(),
  name: SkillNameSchema,
  contentFile: z.string().regex(/^skills\/[a-z0-9-]+\/SKILL\.md$/),
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
});

const PlatformSkillCatalogSchema = z.object({
  schemaVersion: z.literal(1),
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
};

export type PlatformContentCatalog = {
  schemaVersion: 1;
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
): Promise<PlatformContentCatalog> {
  const catalog = PlatformSkillCatalogSchema.parse(input);
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

    ids.add(entry.id);
    names.add(entry.name);
    skills.push({
      ...entry,
      description: source.description,
      content: source.content,
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
  const catalogPath = resolve(rootDirectory, 'skills/catalog.json');
  const skillsRoot = `${resolve(rootDirectory, 'skills')}${sep}`;
  const raw = await readFile(catalogPath, 'utf8');
  const input = JSON.parse(raw) as unknown;

  return parsePlatformContentCatalog(input, async (contentFile) => {
    const absolutePath = resolve(rootDirectory, contentFile);
    if (!absolutePath.startsWith(skillsRoot)) {
      throw new Error(`platform_skill_catalog_path_escaped:${contentFile}`);
    }
    return readFile(absolutePath, 'utf8');
  });
}
