import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntimeFixtureDatabase } from '../runtime.fixture.ts';
import { skillBytesChecksum } from '../skill-bundles.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const migration = await readFile(
  new URL(
    '../../migrations/0233_personal_skill_body_limits.sql',
    import.meta.url,
  ),
  'utf8',
);
type Fixture = Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;

suite('L1 existing personal Skill CHECK migration', () => {
  let f: Fixture, rejected: Fixture;
  const ownerId = randomUUID(),
    organizationId = randomUUID();
  let historical: unknown, oldShape: unknown, historicalId: string;

  async function seed(db: Fixture['db']) {
    await db`insert into allrice_users(id,email,display_name,password_hash)
      values(${ownerId},${ownerId + '@example.test'},'Synthetic','not-a-login')`;
    await db`insert into allrice_organizations(id,slug,name)
      values(${organizationId},${organizationId},'Synthetic')`;
  }
  async function insert(
    db: Fixture['db'],
    originalText: string,
    body: string,
    name = 'limit-' + randomUUID(),
  ) {
    const installationId = randomUUID(),
      versionId = randomUUID();
    const checksum = skillBytesChecksum(body);
    await db.begin(async (tx) => {
      await tx`insert into allrice_personal_skill_installations
        (id,organization_id,owner_id,name,state,current_version_id)
        values(${installationId},${organizationId},${ownerId},${name},'installed',${versionId})`;
      await tx`insert into allrice_personal_skill_versions
        (id,organization_id,owner_id,installation_id,version,source,original_text,definition,definition_checksum)
        values(${versionId},${organizationId},${ownerId},${installationId},1,${tx.json({ kind: 'synthetic' })},${originalText},
          ${tx.json({ name, description: 'Synthetic', content: body, checksum, invocation: { modelInvocable: true, userInvocable: true } })},${checksum})`;
    });
    return versionId;
  }
  async function shape(db: Fixture['db']) {
    return {
      columns:
        await db`select attname,atttypid,attnotnull,attidentity,attgenerated
        from pg_attribute where attrelid='allrice_personal_skill_versions'::regclass and attnum>0 and not attisdropped order by attnum`,
      otherConstraints:
        await db`select conname,contype,pg_get_constraintdef(oid) definition
        from pg_constraint where conrelid='allrice_personal_skill_versions'::regclass
          and conname not in ('allrice_personal_skill_versions_original_text_check','allrice_personal_skill_versions_content_bytes_check') order by conname`,
      triggers:
        await db`select tgname,pg_get_triggerdef(oid) definition from pg_trigger
        where tgrelid='allrice_personal_skill_versions'::regclass order by tgname`,
    };
  }
  beforeAll(async () => {
    f = await createRuntimeFixtureDatabase({
      ownSchemaOnly: true,
      throughMigration: '0232_employee_memory_operations.sql',
    });
    await seed(f.db);
    historicalId = await insert(f.db, '---\nname: old\n---\n旧正文', '旧正文');
    [historical] =
      await f.db`select to_jsonb(v) value from allrice_personal_skill_versions v where id=${historicalId}`;
    oldShape = await shape(f.db);
    await f.db.begin((tx) => tx.unsafe(migration));
    rejected = await createRuntimeFixtureDatabase({
      ownSchemaOnly: true,
      throughMigration: '0232_employee_memory_operations.sql',
    });
    await seed(rejected.db);
  }, 120000);
  afterAll(async () => {
    await Promise.all([f?.close(), rejected?.close()]);
  });

  it('changes only the two CHECKs and retains exact historical source and definition', async () => {
    const [after] =
      await f.db`select to_jsonb(v) value from allrice_personal_skill_versions v where id=${historicalId}`;
    expect(after).toEqual(historical);
    expect(await shape(f.db)).toEqual(oldShape);
    const checks = await f.db`select conname,convalidated from pg_constraint
      where conrelid='allrice_personal_skill_versions'::regclass
        and conname in ('allrice_personal_skill_versions_original_text_check','allrice_personal_skill_versions_content_bytes_check') order by conname`;
    expect(checks).toEqual([
      {
        conname: 'allrice_personal_skill_versions_content_bytes_check',
        convalidated: true,
      },
      {
        conname: 'allrice_personal_skill_versions_original_text_check',
        convalidated: true,
      },
    ]);
  });

  it('accepts exact UTF-8 body and raw limits with frontmatter overhead', async () => {
    const body = '中'.repeat(87_381) + 'a';
    expect(Buffer.byteLength(body)).toBe(262_144);
    const id = await insert(f.db, '---\nname: limit\n---\n' + body, body);
    const rawId = await insert(f.db, 'x'.repeat(8_000_000), 'body');
    const rows = await f.db`select id,octet_length(original_text) raw_bytes,
      octet_length(definition->>'content') body_bytes from allrice_personal_skill_versions where id in (${id},${rawId}) order by id`;
    expect(rows.find((row) => row.id === id)).toMatchObject({
      body_bytes: 262_144,
    });
    expect(rows.find((row) => row.id === id)!.raw_bytes).toBeGreaterThan(
      262_144,
    );
    expect(rows.find((row) => row.id === rawId)).toMatchObject({
      raw_bytes: 8_000_000,
      body_bytes: 4,
    });
  });

  it('rejects overflow atomically and retains the 64 character installation name limit', async () => {
    const count = async () =>
      (
        await f.db`select
      (select count(*)::int from allrice_personal_skill_versions) versions,
      (select count(*)::int from allrice_personal_skill_installations) installations`
      )[0];
    const before = await count();
    for (const [raw, body, constraint] of [
      [
        'x'.repeat(8_000_001),
        'body',
        'allrice_personal_skill_versions_original_text_check',
      ],
      [
        'raw',
        'x'.repeat(262_145),
        'allrice_personal_skill_versions_content_bytes_check',
      ],
      [
        'raw',
        '中'.repeat(87_382),
        'allrice_personal_skill_versions_content_bytes_check',
      ],
    ]) {
      await expect(insert(f.db, raw!, body!)).rejects.toMatchObject({
        code: '23514',
        constraint_name: constraint,
      });
      expect(await count()).toEqual(before);
    }
    await expect(
      insert(f.db, 'raw', 'body', 'a'.repeat(65)),
    ).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'allrice_personal_skill_installations_name_check',
    });
    expect(await count()).toEqual(before);
  });

  it('fails a violating historical definition without rewriting it or partially changing CHECKs', async () => {
    const id = await insert(rejected.db, 'legacy raw', '中'.repeat(87_382));
    const [before] =
      await rejected.db`select to_jsonb(v) value from allrice_personal_skill_versions v where id=${id}`;
    await expect(
      rejected.db.begin((tx) => tx.unsafe(migration)),
    ).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'allrice_personal_skill_versions_content_bytes_check',
    });
    const [after] =
      await rejected.db`select to_jsonb(v) value from allrice_personal_skill_versions v where id=${id}`;
    expect(after).toEqual(before);
    const [added] =
      await rejected.db`select count(*)::int count from pg_constraint
      where conrelid='allrice_personal_skill_versions'::regclass and conname='allrice_personal_skill_versions_content_bytes_check'`;
    expect(added!.count).toBe(0);
    await expect(
      insert(rejected.db, 'x'.repeat(262_145), 'body'),
    ).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'allrice_personal_skill_versions_original_text_check',
    });
  });
});
