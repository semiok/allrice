import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { crc32, deflateSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertRuntimeFixtureDatabase } from '../../packages/database/src/runtime-fixture-database.ts';
import {
  findSmokeCsvDelivery,
  smokeCsvProofSql,
  validateSmokeCsvPng,
} from './smoke-reply.mjs';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [
  org,
  workspace,
  owner,
  sessionId,
  userMessageId,
  assistantMessageId,
  runId,
  objectId,
  version,
] = Array.from({ length: 9 }, (_, i) => id(i + 1));
const prompt = '冒烟测试 scope：按渠道汇总这个 CSV，画一张柱状图。';
const base = 'https://allrice.invalid';
const href = `/api/v1/files/${objectId}/download`;
const caption = '渠道下单量柱状图';
const markdown = `![${caption}](${href})`;
const input = {
  sessionId,
  userMessageId,
  assistantMessageId,
  runId,
  prompt,
  account: 'smoke',
};
const observed = {
  userMessageId,
  assistantMessageId,
  runId,
  links: [],
  images: [],
  captions: [caption],
};
const chunk = (type, data = Buffer.alloc(0)) => {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
};
function png(
  width = 1,
  imageData = deflateSync(Buffer.from([0, 0, 0, 0, 255])),
) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', imageData),
    chunk('IEND'),
  ]);
}
const metadata = (bytes) => ({
  mediaType: 'image/png',
  sizeBytes: bytes.length,
  checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
});

suite('CSV smoke exact-turn PNG delivery proof', () => {
  let sql, schema, fromMarkdown;
  beforeAll(async () => {
    const url = process.env.ALLRICE_TEST_DATABASE_URL;
    assertRuntimeFixtureDatabase(new URL(url));
    const postgres = createRequire(
      new URL('../../packages/database/package.json', import.meta.url),
    )('postgres');
    sql = postgres(url, { max: 1 });
    schema = `smoke_csv_${randomUUID().replaceAll('-', '')}`;
    await sql.unsafe(`create schema ${schema}`);
    await sql.unsafe(`set search_path to ${schema}`);
    // Minimal physical columns of the existing read-only query, no product migrations or Runs.
    await sql.unsafe(`
      create table allrice_users(id uuid,username text);
      create table allrice_chat_sessions(id uuid,organization_id uuid,workspace_id uuid,owner_id uuid);
      create table allrice_runs(id uuid,organization_id uuid,workspace_id uuid,owner_id uuid,state text);
      create table allrice_employee_runs(run_id uuid,organization_id uuid,workspace_id uuid,owner_id uuid,session_id uuid,user_message_id uuid,assistant_message_id uuid,status text);
      create table allrice_messages(id uuid,organization_id uuid,workspace_id uuid,owner_id uuid,session_id uuid,role text,status text,content jsonb);
      create table allrice_workbench_artifacts(version_id uuid,organization_id uuid,workspace_id uuid,owner_id uuid,run_id uuid);
      create table allrice_deliverable_versions(id uuid,organization_id uuid,workspace_id uuid,owner_id uuid,object_id uuid,session_id uuid,format text,file_name text);
      create table allrice_storage_objects(id uuid,organization_id uuid,workspace_id uuid,owner_id uuid,media_type text,size_bytes bigint,checksum text,state text,immutable boolean,category text,deleted_at timestamptz,retention_until timestamptz);
      create table allrice_file_references(object_id uuid,session_id uuid,organization_id uuid,workspace_id uuid,owner_id uuid);
    `);
    const webRequire = createRequire(
      new URL('../../apps/web/package.json', import.meta.url),
    );
    ({ fromMarkdown } = await import(
      webRequire.resolve('mdast-util-from-markdown')
    ));
  }, 30_000);
  afterAll(async () => {
    try {
      if (schema) await sql.unsafe(`drop schema if exists ${schema} cascade`);
    } finally {
      await sql?.end();
    }
  }, 30_000);
  beforeEach(async () => {
    await sql.unsafe(
      'truncate allrice_users,allrice_chat_sessions,allrice_runs,allrice_employee_runs,allrice_messages,allrice_workbench_artifacts,allrice_deliverable_versions,allrice_storage_objects,allrice_file_references',
    );
    await sql`insert into allrice_users values(${owner},'smoke')`;
    await sql`insert into allrice_chat_sessions values(${sessionId},${org},${workspace},${owner})`;
    await sql`insert into allrice_runs values(${runId},${org},${workspace},${owner},'succeeded')`;
    await sql`insert into allrice_employee_runs values(${runId},${org},${workspace},${owner},${sessionId},${userMessageId},${assistantMessageId},'succeeded')`;
    await sql`insert into allrice_messages values(${userMessageId},${org},${workspace},${owner},${sessionId},'user','completed',${sql.json({ text: prompt })}),
      (${assistantMessageId},${org},${workspace},${owner},${sessionId},'assistant','completed',${sql.json({ text: markdown })})`;
    await sql`insert into allrice_workbench_artifacts values(${version},${org},${workspace},${owner},${runId})`;
    await sql`insert into allrice_deliverable_versions values(${version},${org},${workspace},${owner},${objectId},${sessionId},'png','渠道汇总.png')`;
    const meta = metadata(png());
    await sql`insert into allrice_storage_objects values(${objectId},${org},${workspace},${owner},'image/png',${meta.sizeBytes},${meta.checksum},'ready',true,'exports',null,null)`;
    await sql`insert into allrice_file_references values(${objectId},${sessionId},${org},${workspace},${owner})`;
  });
  const proof = async (overrides = {}) =>
    (await sql.unsafe(smokeCsvProofSql({ ...input, ...overrides })))[0]?.proof;
  const find = (record, changes = {}) =>
    findSmokeCsvDelivery({
      observed,
      proof: record,
      sessionId,
      base,
      fromMarkdown,
      ...changes,
    });

  it.each(['exports', 'artifacts'])(
    'proves one exact user→Run→assistant and its generated session PNG in %s',
    async (category) => {
      await sql`update allrice_storage_objects set category=${category}`;
      const record = await proof();
      expect(record).toMatchObject({
        sessionId,
        userMessageId,
        assistantMessageId,
        runId,
        objects: [
          {
            id: objectId,
            runId,
            sessionId,
            state: 'ready',
            immutable: true,
            format: 'png',
          },
        ],
      });
      expect(find(record)).toMatchObject({
        id: objectId,
        href: `${base}${href}`,
        kind: 'native-caption',
      });
      expect(
        validateSmokeCsvPng(png(), record.objects[0], 'image/png'),
      ).toMatchObject({ width: 1, height: 1 });
    },
  );
  it.each([
    'sessionId',
    'userMessageId',
    'assistantMessageId',
    'runId',
    'prompt',
    'account',
  ])('rejects a different %s at the real SQL boundary', async (key) => {
    expect(
      await proof({ [key]: key.endsWith('Id') ? id(99) : 'different' }),
    ).toBeUndefined();
  });
  it.each([
    [
      'allrice_messages',
      `session_id='${id(99)}'`,
      `id='${assistantMessageId}'`,
    ],
    ['allrice_messages', "status='failed'", `id='${assistantMessageId}'`],
    ['allrice_messages', "role='user'", `id='${assistantMessageId}'`],
    ['allrice_messages', `owner_id='${id(99)}'`, `id='${userMessageId}'`],
    ['allrice_runs', "state='failed'", 'true'],
    ['allrice_employee_runs', "status='running'", 'true'],
    ['allrice_chat_sessions', `workspace_id='${id(99)}'`, 'true'],
  ])(
    'rejects mismatched/completing turn rows: %s %s',
    async (table, change, where) => {
      await sql.unsafe(`update ${table} set ${change} where ${where}`);
      expect(await proof()).toBeUndefined();
    },
  );
  it.each([
    ['allrice_workbench_artifacts', `run_id='${id(99)}'`],
    ['allrice_workbench_artifacts', `owner_id='${id(99)}'`],
    ['allrice_deliverable_versions', `session_id='${id(99)}'`],
    ['allrice_deliverable_versions', `object_id='${id(99)}'`],
    ['allrice_file_references', `session_id='${id(99)}'`],
    ['allrice_file_references', `organization_id='${id(99)}'`],
    ['allrice_storage_objects', `workspace_id='${id(99)}'`],
    ['allrice_storage_objects', "media_type='image/jpeg'"],
    ['allrice_storage_objects', "state='pending'"],
    ['allrice_storage_objects', 'immutable=false'],
    ['allrice_storage_objects', "category='uploads'"],
    [
      'allrice_storage_objects',
      "retention_until=clock_timestamp()-interval '1 day'",
    ],
  ])(
    'rejects unrelated or unavailable delivery rows: %s %s',
    async (table, change) => {
      await sql.unsafe(`update ${table} set ${change}`);
      const record = await proof();
      expect(record.objects).toEqual([]);
      expect(() => find(record)).toThrow('csv_current_png_delivery_missing');
    },
  );
  it('keeps ordinary named anchors and extensionless img URLs', async () => {
    const record = await proof();
    expect(
      find(
        { ...record, text: `[下载柱状图](${href})` },
        {
          observed: {
            ...observed,
            captions: [],
            links: [{ href: `${href}?name=result.png`, text: '下载柱状图' }],
          },
        },
      ).kind,
    ).toBe('anchor');
    expect(
      find(record, { observed: { ...observed, captions: [], images: [href] } })
        .kind,
    ).toBe('img');
    expect(() =>
      find(record, {
        observed: {
          ...observed,
          captions: [],
          images: [`/api/v1/files/${id(99)}/download`],
        },
      }),
    ).toThrow();
    expect(() =>
      find(record, {
        observed: {
          ...observed,
          captions: [],
          images: [`https://elsewhere.invalid${href}`],
        },
      }),
    ).toThrow();
    expect(() =>
      find(record, { observed: { ...observed, runId: id(99) } }),
    ).toThrow('csv_turn_not_confirmed');
    expect(() =>
      find(record, { observed: { ...observed, assistantMessageId: id(99) } }),
    ).toThrow('csv_turn_not_confirmed');
  });
  it.each([
    `\`${markdown}\``,
    `\`\`\`md\n${markdown}\n\`\`\``,
    `<!-- ${markdown} -->`,
    `[${caption}](${href})`,
  ])(
    'does not turn code, comments or an ordinary unnamed link into an image: %s',
    async (text) => {
      const record = await proof();
      expect(() => find({ ...record, text })).toThrow(
        'csv_current_png_delivery_missing',
      );
    },
  );
  it('parses reference images, but requires a same-origin delivery and exact native caption', async () => {
    const record = await proof();
    expect(
      find({ ...record, text: `![${caption}][image]\n\n[image]: ${href}` })
        .kind,
    ).toBe('native-caption');
    expect(() =>
      find({
        ...record,
        text: `![${caption}](https://elsewhere.invalid${href})`,
      }),
    ).toThrow();
    expect(() =>
      find(record, {
        observed: { ...observed, captions: [`earlier ${caption}`] },
      }),
    ).toThrow();
    expect(() =>
      find({
        ...record,
        text: `${markdown}\n\n![${caption}](/api/v1/files/${id(99)}/download)`,
      }),
    ).toThrow();
  });
  it('rejects wrong HTTP/ledger MIME, size/hash, corrupt CRC, truncation and invalid dimensions', () => {
    const bytes = png(),
      meta = metadata(bytes);
    for (const invalid of [
      { ...meta, mediaType: 'image/jpeg' },
      { ...meta, sizeBytes: bytes.length + 1 },
      { ...meta, checksum: `sha256:${'0'.repeat(64)}` },
    ])
      expect(() => validateSmokeCsvPng(bytes, invalid, 'image/png')).toThrow();
    expect(() =>
      validateSmokeCsvPng(bytes, meta, 'application/octet-stream'),
    ).toThrow();
    const corrupt = Buffer.from(bytes);
    corrupt[45] ^= 1;
    expect(() =>
      validateSmokeCsvPng(corrupt, metadata(corrupt), 'image/png'),
    ).toThrow('csv_png_crc_invalid');
    for (const invalid of [
      Buffer.from('not a PNG'),
      bytes.subarray(0, -1),
      Buffer.concat([bytes, Buffer.from('tail')]),
      png(8193),
    ])
      expect(() =>
        validateSmokeCsvPng(invalid, metadata(invalid), 'image/png'),
      ).toThrow();
  });
});
