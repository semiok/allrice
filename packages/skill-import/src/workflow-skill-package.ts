import {
  WorkflowSkillFrontmatterSchema,
  PersonalSkillDefinitionSchema,
  PersonalSceneFileSchema,
  type SkillPackageSource,
} from '@allrice/contracts';
import {
  EmployeeContentError,
  parseWorkflowSkillSections,
  skillBytesChecksum,
  skillBundleChecksum,
} from '@allrice/database';
import { parseNativeSkill } from './personal-skill-import.ts';
import { assertWorkflowSkillFrontmatter } from './workflow-skill-frontmatter.ts';
import {
  inspectSkillPackage,
  type PersonalSkillPackageFile,
} from './personal-skill-package.ts';

async function parseWorkflowSkill(bytes: Uint8Array) {
  try {
    assertWorkflowSkillFrontmatter(bytes);
  } catch {
    throw new EmployeeContentError('workflow_invalid');
  }
  const { originalText, skill } = await parseNativeSkill(bytes);
  const frontmatter = WorkflowSkillFrontmatterSchema.parse({
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse,
    invocation: skill.invocation,
    metadata: skill.metadata,
  });
  const content = PersonalSkillDefinitionSchema.shape.content.parse(
    skill.content,
  );
  try {
    parseWorkflowSkillSections(content);
  } catch {
    throw new EmployeeContentError('workflow_invalid');
  }
  return { originalText, definition: { ...frontmatter, content }, frontmatter };
}

/** Build the existing C1 portable file from inspected source bytes. No grants,
 * dependency installation or executable scripts are derived from the body. */
export async function inspectWorkflowSkillPackage(
  files: readonly PersonalSkillPackageFile[],
  source: SkillPackageSource,
  sceneId: string,
  signal?: AbortSignal,
) {
  const [candidate] = await inspectSkillPackage(
    files,
    parseWorkflowSkill,
    signal,
    ['SKILL.md'],
  );
  if (!candidate?.parsed || candidate.issues.length)
    throw new EmployeeContentError('workflow_invalid');
  const { definition, frontmatter } = candidate.parsed;
  const bundleInput = {
    schemaVersion: 1 as const,
    // Internal bundle schema versioning is separate from native author metadata.
    version: '1.0.0',
    contentChecksum: skillBytesChecksum(definition.content),
    sourceRef:
      source.kind === 'github'
        ? `https://github.com/${source.owner}/${source.repository}/tree/${source.commitSha}`
        : `urn:allrice:uploaded-skill:${source.originalChecksum}`,
    license:
      source.kind === 'github' &&
      source.license.status === 'provider-metadata-only'
        ? source.license.identifier
        : 'unknown',
    reviewedBy: 'owner-confirmed import; no platform review',
    dependencies: [],
    resources: candidate.resources.map((resource) => ({
      path: resource.path,
      mediaType: 'application/octet-stream',
      byteLength: resource.byteLength,
      checksum: resource.checksum,
      contentBase64: Buffer.from(resource.bytes).toString('base64'),
    })),
  };
  const file = PersonalSceneFileSchema.safeParse({
    schemaVersion: 1,
    scene: {
      id: sceneId,
      name: frontmatter.metadata.displayName,
      appliesWhen: frontmatter.description,
      nativeName: frontmatter.name,
    },
    procedure: {
      kind: 'procedure',
      title: frontmatter.metadata.displayName,
      body: definition.content,
      skillPackage: {
        frontmatter,
        source,
        bundle: { ...bundleInput, checksum: skillBundleChecksum(bundleInput) },
        resourceSources: [],
      },
    },
    references: [],
  });
  if (!file.success) throw new EmployeeContentError('workflow_invalid');
  return {
    file: file.data,
    frontmatter,
    content: definition.content,
    ...parseWorkflowSkillSections(definition.content),
  };
}
