import { createHash } from 'node:crypto';

import { approvedSkillCandidates } from '../apps/web/lib/skillhub/approved-skills.ts';
import { StorageObjectSchema } from '../packages/contracts/src/storage.ts';
import { closeDatabase, getDatabase } from '../packages/database/src/index.ts';
import { LocalStorageAdapter } from '../packages/storage/src/local.ts';

type Source = {
  repository: string;
  commit: string;
  path: string;
  license: string;
};

type ArtifactRow = {
  skill_version_id: string;
  slug: string;
  version: string;
  source: Source;
  object_id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  object_key: string;
  checksum: string;
  media_type: string;
  size_bytes: number | string;
  retention_until: Date | null;
  deleted_at: Date | null;
  immutable: boolean;
};

function databaseUrl() {
  return (
    process.env.DATABASE_URL ??
    `postgres://allrice:allrice@127.0.0.1:${process.env.ALLRICE_DEV_DB_PORT ?? '54329'}/allrice`
  );
}

function sameSource(left: Source, right: Source) {
  return (
    left.repository === right.repository &&
    left.commit === right.commit &&
    left.path === right.path &&
    left.license === right.license
  );
}

process.env.DATABASE_URL ??= databaseUrl();
const sql = getDatabase();
const storage = new LocalStorageAdapter(
  process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
);
const candidates = Object.values(approvedSkillCandidates);
let restored = 0;
let missingUnrecoverable = 0;

try {
  const rows = await sql<ArtifactRow[]>`
    select
      v.id as skill_version_id,
      c.slug,
      v.version,
      v.source,
      o.id as object_id,
      o.organization_id,
      o.workspace_id,
      o.owner_id,
      o.object_key,
      o.checksum,
      o.media_type,
      o.size_bytes,
      o.retention_until,
      o.deleted_at,
      o.immutable
    from allrice_skill_versions v
    join allrice_catalog_skills c on c.id = v.catalog_skill_id
    join allrice_storage_objects o on o.id = v.artifact_object_id
    where v.status = 'published' and o.state = 'ready'
  `;

  for (const row of rows) {
    const object = StorageObjectSchema.parse({
      id: row.object_id,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      ownerId: row.owner_id,
      key: row.object_key,
      checksum: row.checksum,
      mediaType: row.media_type,
      sizeBytes: Number(row.size_bytes),
      retentionUntil: row.retention_until?.toISOString() ?? null,
      deletedAt: row.deleted_at?.toISOString() ?? null,
      immutable: row.immutable,
    });

    if (await storage.exists(object)) continue;

    const candidate = candidates.find(
      (item) =>
        item.slug === row.slug &&
        item.version === row.version &&
        sameSource(item.source, row.source),
    );
    if (!candidate) {
      missingUnrecoverable += 1;
      console.warn(
        `[storage] missing unrecoverable Skill artifact: ${row.slug}@${row.version} (${row.object_key})`,
      );
      continue;
    }

    const content = Buffer.from(JSON.stringify(candidate.bundle), 'utf8');
    const checksum = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    if (
      content.byteLength !== object.sizeBytes ||
      checksum !== object.checksum
    ) {
      throw new Error(
        `[storage] built-in Skill artifact metadata drifted for ${row.slug}@${row.version}; publish a new immutable version instead of mutating this artifact`,
      );
    }

    await storage.put(object, new Blob([content]).stream());
    restored += 1;
    console.info(
      `[storage] restored Skill artifact: ${row.slug}@${row.version}`,
    );
  }

  if (missingUnrecoverable > 0) {
    throw new Error(
      `[storage] ${missingUnrecoverable} Skill artifact(s) are missing and cannot be restored automatically; restore them from backup or re-import them in SkillHub`,
    );
  }

  console.info(
    `[storage] Skill artifact check complete (restored ${restored})`,
  );
} finally {
  await closeDatabase();
}
