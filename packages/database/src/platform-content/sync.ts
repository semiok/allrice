import type postgres from 'postgres';

import { getDatabase } from '../core/client.ts';
import type {
  PlatformContentCatalog,
  ResolvedPlatformSkill,
} from './catalog.ts';

export type ExistingPlatformSkill = Omit<
  ResolvedPlatformSkill,
  'contentFile' | 'createdByLabel' | 'reviewStatus' | 'reviewedByLabel'
> & {
  reviewStatus: 'draft' | 'reviewed' | 'rejected';
  reviewedByLabel: string | null;
};

export type PlatformSkillSyncPlan = {
  inserts: ResolvedPlatformSkill[];
  updates: ResolvedPlatformSkill[];
  unchanged: ResolvedPlatformSkill[];
  unmanaged: ExistingPlatformSkill[];
};

export type PlatformContentSyncResult = {
  inserted: number;
  updated: number;
  unchanged: number;
  unmanaged: number;
  catalogChecksum: string;
};

export function buildPlatformContentCatalogMetadata(
  catalog: PlatformContentCatalog,
) {
  return {
    schemaVersion: catalog.schemaVersion,
    catalogChecksum: catalog.catalogChecksum,
    skills: catalog.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      version: skill.version,
      checksum: skill.checksum,
      sourceRef: skill.sourceRef,
    })),
    authority: 'skills/catalog.json',
    mutationScope: 'platform-skill-catalog-only',
  } as const;
}

function operationalFields(
  skill: ExistingPlatformSkill | ResolvedPlatformSkill,
) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    checksum: skill.checksum,
    modelInvocable: skill.modelInvocable,
    userInvocable: skill.userInvocable,
    requiredToolRefs: skill.requiredToolRefs,
    enabled: skill.enabled,
    source: skill.source,
    sourceRef: skill.sourceRef,
    version: skill.version,
    license: skill.license,
    reviewStatus: skill.reviewStatus,
    reviewedByLabel: skill.reviewedByLabel,
  };
}

function revisionFields(skill: ExistingPlatformSkill | ResolvedPlatformSkill) {
  return {
    description: skill.description,
    content: skill.content,
    checksum: skill.checksum,
    source: skill.source,
    sourceRef: skill.sourceRef,
    license: skill.license,
    requiredToolRefs: skill.requiredToolRefs,
  };
}

function parseSemanticVersion(version: string, skillName: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(
      `platform_skill_existing_version_invalid:${skillName}:${version}`,
    );
  }
  return match.slice(1).map(Number);
}

function compareSemanticVersions(
  desiredVersion: string,
  currentVersion: string,
  skillName: string,
) {
  const desired = parseSemanticVersion(desiredVersion, skillName);
  const current = parseSemanticVersion(currentVersion, skillName);
  for (let index = 0; index < 3; index += 1) {
    if (desired[index]! > current[index]!) return 1;
    if (desired[index]! < current[index]!) return -1;
  }
  return 0;
}

export function planPlatformSkillSync(
  existing: ExistingPlatformSkill[],
  desired: ResolvedPlatformSkill[],
): PlatformSkillSyncPlan {
  const existingById = new Map(existing.map((skill) => [skill.id, skill]));
  const existingByName = new Map(existing.map((skill) => [skill.name, skill]));
  const managedIds = new Set<string>();
  const inserts: ResolvedPlatformSkill[] = [];
  const updates: ResolvedPlatformSkill[] = [];
  const unchanged: ResolvedPlatformSkill[] = [];

  for (const skill of desired) {
    const byId = existingById.get(skill.id);
    const byName = existingByName.get(skill.name);
    if (byId && byId.name !== skill.name) {
      throw new Error(`platform_skill_identity_conflict:${skill.id}`);
    }
    if (byName && byName.id !== skill.id) {
      throw new Error(`platform_skill_identity_conflict:${skill.name}`);
    }

    const current = byId ?? byName;
    managedIds.add(skill.id);
    if (!current) {
      inserts.push(skill);
    } else {
      const versionComparison = compareSemanticVersions(
        skill.version,
        current.version,
        skill.name,
      );
      if (versionComparison < 0) {
        throw new Error(
          `platform_skill_version_regression:${skill.name}:${current.version}->${skill.version}`,
        );
      }
      if (
        versionComparison === 0 &&
        JSON.stringify(revisionFields(current)) !==
          JSON.stringify(revisionFields(skill))
      ) {
        throw new Error(
          `platform_skill_version_bump_required:${skill.name}:${skill.version}`,
        );
      }
      if (
        JSON.stringify(operationalFields(current)) ===
        JSON.stringify(operationalFields(skill))
      ) {
        unchanged.push(skill);
      } else {
        updates.push(skill);
      }
    }
  }

  return {
    inserts,
    updates,
    unchanged,
    // Catalog sync is deliberately non-destructive. Rows not represented by
    // the operational catalog remain in place for explicit human governance.
    unmanaged: existing.filter((skill) => !managedIds.has(skill.id)),
  };
}

type PlatformSkillRow = {
  id: string;
  name: string;
  description: string;
  content: string;
  checksum: string;
  modelInvocable: boolean;
  userInvocable: boolean;
  requiredToolRefs: string[];
  enabled: boolean;
  source: 'allrice' | 'dsh-migrated';
  sourceRef: string;
  version: string;
  license: string;
  reviewStatus: 'draft' | 'reviewed' | 'rejected';
  reviewedByLabel: string | null;
};

async function readExistingSkills(transaction: postgres.TransactionSql) {
  return transaction<PlatformSkillRow[]>`
    select id, name, description, content, checksum,
      model_invocable as "modelInvocable",
      user_invocable as "userInvocable",
      required_tool_refs as "requiredToolRefs", enabled, source,
      source_ref as "sourceRef", version, license,
      review_status as "reviewStatus",
      reviewed_by_label as "reviewedByLabel"
    from allrice_platform_dsh_skills
    order by name, id
    for update
  `;
}

async function insertSkill(
  transaction: postgres.TransactionSql,
  skill: ResolvedPlatformSkill,
) {
  await transaction`
    insert into allrice_platform_dsh_skills (
      id, name, description, content, checksum, model_invocable,
      user_invocable, required_tool_refs, enabled, source, created_by_label,
      source_ref, version, license, review_status, reviewed_by_label,
      reviewed_at
    ) values (
      ${skill.id}, ${skill.name}, ${skill.description}, ${skill.content},
      ${skill.checksum}, ${skill.modelInvocable}, ${skill.userInvocable},
      ${transaction.json(skill.requiredToolRefs)}, ${skill.enabled},
      ${skill.source}, ${skill.createdByLabel}, ${skill.sourceRef},
      ${skill.version}, ${skill.license}, ${skill.reviewStatus},
      ${skill.reviewedByLabel}, now()
    )
  `;
}

async function updateSkill(
  transaction: postgres.TransactionSql,
  skill: ResolvedPlatformSkill,
) {
  await transaction`
    update allrice_platform_dsh_skills
    set description = ${skill.description}, content = ${skill.content},
      checksum = ${skill.checksum}, model_invocable = ${skill.modelInvocable},
      user_invocable = ${skill.userInvocable},
      required_tool_refs = ${transaction.json(skill.requiredToolRefs)},
      enabled = ${skill.enabled}, source = ${skill.source},
      source_ref = ${skill.sourceRef}, version = ${skill.version},
      license = ${skill.license}, review_status = ${skill.reviewStatus},
      reviewed_by_label = ${skill.reviewedByLabel},
      reviewed_at = case
        when checksum is distinct from ${skill.checksum}
          or version is distinct from ${skill.version}
          or description is distinct from ${skill.description}
          or source is distinct from ${skill.source}
          or source_ref is distinct from ${skill.sourceRef}
          or license is distinct from ${skill.license}
          or required_tool_refs is distinct from
            ${transaction.json(skill.requiredToolRefs)}
          or review_status is distinct from ${skill.reviewStatus}
          or reviewed_by_label is distinct from ${skill.reviewedByLabel}
        then now()
        else reviewed_at
      end,
      updated_at = now()
    where id = ${skill.id} and name = ${skill.name}
  `;
}

export async function synchronizePlatformContent(
  catalog: PlatformContentCatalog,
): Promise<PlatformContentSyncResult> {
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(9223372036854769001)`;
    const existing = await readExistingSkills(transaction);
    const plan = planPlatformSkillSync(existing, catalog.skills);

    for (const skill of plan.inserts) await insertSkill(transaction, skill);
    for (const skill of plan.updates) await updateSkill(transaction, skill);

    const metadata = buildPlatformContentCatalogMetadata(catalog);
    await transaction`
      insert into allrice_runtime_metadata (key, value)
      values ('platform-content-catalog', ${transaction.json(metadata)})
      on conflict (key) do update
      set value = excluded.value, updated_at = now()
      where allrice_runtime_metadata.value is distinct from excluded.value
    `;

    return {
      inserted: plan.inserts.length,
      updated: plan.updates.length,
      unchanged: plan.unchanged.length,
      unmanaged: plan.unmanaged.length,
      catalogChecksum: catalog.catalogChecksum,
    };
  });
}
