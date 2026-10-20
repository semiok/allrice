import { z } from 'zod';
import type postgres from 'postgres';
import {
  EmployeeBaseSkillCatalogSchema,
  type EmployeeBaseSkillCatalog,
  type DshNativeSkillSnapshot,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import { validateFrozenSkill } from '../skill-bundles.ts';
import { readExistingPlatformSkills } from '../platform-content/sync.ts';

const metadataSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    catalogChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    authority: z.literal('skills/catalog.json'),
    mutationScope: z.literal('platform-skill-catalog-only'),
    skills: z
      .array(
        z
          .object({
            id: z.uuid(),
            name: z.string(),
            version: z.string(),
            checksum: z.string(),
            sourceRef: z.string(),
            bundleChecksum: z.string().optional(),
            replaces: z.array(z.uuid()).optional(),
          })
          .strict(),
      )
      .max(128),
  })
  .strict();

// Only the directory and one selected Skill enter model context through DSH.
// This also bounds the stored Run payload (bundled resources included).
export const employeeBaseSkillLimits = {
  count: 64,
  snapshotBytes: 8_000_000,
} as const;

/** Neither foundation Skills nor their dependencies are an authorization input.
 * Call this only AFTER computing the employee's original capability grants. */
export async function freezeEmployeeBaseSkills(
  original: DshNativeSkillSnapshot[],
  transaction?: postgres.TransactionSql,
) {
  const freeze = async (sql: postgres.TransactionSql) => {
    const [record] = await sql<{ value: unknown }[]>`
      select value from allrice_runtime_metadata where key='platform-content-catalog'`;
    // Pre-catalog installations keep their published package. Deployment's
    // existing content:sync populates this record; do not invent a catalog.
    if (!record) return { nativeSkills: original, catalog: undefined };
    const metadata = metadataSchema.parse(record.value);
    const rows = await readExistingPlatformSkills(sql);
    const selected: DshNativeSkillSnapshot[] = [];
    const governance: EmployeeBaseSkillCatalog['skills'] = [];
    const seenIds = new Set<string>(),
      seenNames = new Set<string>();
    for (const entry of metadata.skills) {
      if (seenIds.has(entry.id) || seenNames.has(entry.name))
        throw Error('base_skill_catalog_identity_conflict');
      seenIds.add(entry.id);
      seenNames.add(entry.name);
      const row = rows.find((r) => r.id === entry.id);
      if (!row || row.name !== entry.name)
        throw Error('base_skill_catalog_source_missing');
      // An explicit disable/rejection is respected without a content sync.
      if (!row.enabled || row.reviewStatus !== 'reviewed') continue;
      if (
        row.version !== entry.version ||
        row.checksum !== entry.checksum ||
        row.sourceRef !== entry.sourceRef ||
        (row.bundle?.checksum ?? undefined) !== entry.bundleChecksum ||
        !row.reviewedByLabel
      )
        throw Error('base_skill_catalog_source_changed');
      const skill = validateFrozenSkill({
        id: row.id,
        name: row.name,
        description: row.description,
        content: row.content,
        checksum: row.checksum,
        invocation: {
          modelInvocable: row.modelInvocable,
          userInvocable: row.userInvocable,
        },
        requiredToolRefs: row.requiredToolRefs,
        ...(row.bundle ? { bundle: row.bundle } : {}),
      });
      if (
        skill.bundle &&
        (skill.bundle.version !== row.version ||
          skill.bundle.license !== row.license ||
          skill.bundle.sourceRef !== row.sourceRef ||
          skill.bundle.reviewedBy !== row.reviewedByLabel)
      )
        throw Error('base_skill_bundle_governance_mismatch');
      selected.push(skill);
      governance.push({
        id: row.id,
        name: row.name,
        version: row.version,
        checksum: row.checksum,
        ...(skill.bundle ? { bundleChecksum: skill.bundle.checksum } : {}),
        source: row.source,
        sourceRef: row.sourceRef,
        license: row.license,
        reviewedByLabel: row.reviewedByLabel,
      });
    }
    // Managed IDs follow this catalog for NEW Runs, including a disabled entry.
    // Non-catalog employee-specific Skills keep their immutable publication.
    const replacedIds = new Set(
      metadata.skills.flatMap((s) => s.replaces ?? []),
    );
    const extras = original.filter(
      (s) => !seenIds.has(s.id) && !replacedIds.has(s.id),
    );
    for (const skill of extras) {
      validateFrozenSkill(skill);
      if (seenNames.has(skill.name))
        throw Error('base_skill_catalog_identity_conflict');
    }
    for (const skill of original) {
      const entry = metadata.skills.find((e) => e.id === skill.id);
      if (entry && entry.name !== skill.name)
        throw Error('base_skill_catalog_identity_conflict');
    }
    const nativeSkills = [...selected, ...extras].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
    if (
      new Set(nativeSkills.map((s) => s.id)).size !== nativeSkills.length ||
      new Set(nativeSkills.map((s) => s.name)).size !== nativeSkills.length
    )
      throw Error('base_skill_catalog_identity_conflict');
    assertBudget(nativeSkills);
    const catalog = EmployeeBaseSkillCatalogSchema.parse({
      schemaVersion: 1,
      authority: 'skills/catalog.json',
      catalogChecksum: metadata.catalogChecksum,
      snapshotChecksum: runtimePolicyDigest({
        skills: governance,
        nativeSkills,
      }),
      skills: governance,
    });
    return { nativeSkills, catalog };
  };
  return transaction
    ? freeze(transaction)
    : getDatabase().begin('isolation level repeatable read read only', freeze);
}

function assertBudget(skills: DshNativeSkillSnapshot[]) {
  if (
    skills.length > employeeBaseSkillLimits.count ||
    Buffer.byteLength(JSON.stringify(skills)) >
      employeeBaseSkillLimits.snapshotBytes
  )
    throw Error('base_skill_catalog_budget_exceeded');
}

/** Check the stored Run, never substitute today's catalog on retry/resume. */
export function assertFrozenBaseSkillCatalog(
  input: EmployeeBaseSkillCatalog,
  nativeSkills: DshNativeSkillSnapshot[],
) {
  const catalog = EmployeeBaseSkillCatalogSchema.parse(input);
  assertBudget(nativeSkills);
  if (
    runtimePolicyDigest({ skills: catalog.skills, nativeSkills }) !==
    catalog.snapshotChecksum
  )
    throw Error('base_skill_snapshot_checksum_mismatch');
  if (
    new Set(catalog.skills.map((s) => s.id)).size !== catalog.skills.length ||
    new Set(nativeSkills.map((s) => s.id)).size !== nativeSkills.length ||
    new Set(nativeSkills.map((s) => s.name)).size !== nativeSkills.length
  )
    throw Error('base_skill_snapshot_identity_conflict');
  for (const entry of catalog.skills) {
    const skill = nativeSkills.find((s) => s.id === entry.id);
    if (
      !skill ||
      skill.name !== entry.name ||
      skill.checksum !== entry.checksum ||
      (skill.bundle?.checksum ?? undefined) !== entry.bundleChecksum ||
      (skill.bundle &&
        (skill.bundle.version !== entry.version ||
          skill.bundle.sourceRef !== entry.sourceRef ||
          skill.bundle.license !== entry.license ||
          skill.bundle.reviewedBy !== entry.reviewedByLabel))
    )
      throw Error('base_skill_snapshot_governance_mismatch');
  }
}
